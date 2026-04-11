/**
 * StoryKeeper Telegram Channel Extension
 *
 * Extends NanoClaw's TelegramChannel with:
 * 1. Voice pipeline bridge (downloads → IPC → container → audio response)
 * 2. Setup flow (/start → name → language → Supabase profile)
 * 3. Elderly-friendly UX (200-word cap, sentence-boundary splitting, 2s delays)
 * 4. Friendly error messages (never stack traces)
 * 5. Language auto-detect + explicit switch
 */

import fs from 'fs';
import path from 'path';
import { InputFile } from 'grammy';

import { TelegramChannel } from './telegram.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_WORDS = 200;
const CHUNK_DELAY_MS = 2000;
const MIN_VOICE_BYTES = 10240;
const VOICE_MARKER = '__VOICE__';
const TRANSCRIPT_MARKER = '__TRANSCRIPT__';

const setupStates = new Map<string, { step: string; name?: string }>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Supabase ───────────────────────────────────────────────────────────────

async function getSupabaseClient() {
  const envVars = readEnvFile(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
  const url = process.env.SUPABASE_URL || envVars.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || envVars.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function getUserProfile(telegramId: string) {
  const client = await getSupabaseClient();
  if (!client) return null;
  try {
    const resp = await fetch(
      `${client.url}/rest/v1/users?telegram_id=eq.${telegramId}&select=*`,
      { headers: { apikey: client.key, Authorization: `Bearer ${client.key}` } },
    );
    if (!resp.ok) return null;
    const range = resp.headers.get('content-range');
    if (!range || range.includes('/0')) return null;
    const data = (await resp.json()) as Array<Record<string, unknown>>;
    return data[0] || null;
  } catch { return null; }
}

async function createUserProfile(telegramId: string, name: string, language: string): Promise<boolean> {
  const client = await getSupabaseClient();
  if (!client) return false;
  try {
    const resp = await fetch(`${client.url}/rest/v1/users`, {
      method: 'POST',
      headers: {
        apikey: client.key, Authorization: `Bearer ${client.key}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        telegram_id: parseInt(telegramId), first_name: name,
        preferred_name: name, language, tier: 'companion', status: 'active',
      }),
    });
    return resp.ok || resp.status === 201;
  } catch { return false; }
}

async function updateUserLanguage(telegramId: string, language: string): Promise<void> {
  const client = await getSupabaseClient();
  if (!client) return;
  try {
    await fetch(`${client.url}/rest/v1/users?telegram_id=eq.${telegramId}`, {
      method: 'PATCH',
      headers: { apikey: client.key, Authorization: `Bearer ${client.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language }),
    });
  } catch { /* best effort */ }
}

// ── Welcome Messages ───────────────────────────────────────────────────────

const WELCOME_EN = (n: string) =>
  `Welcome, ${n}! I'm your StoryKeeper companion.\n\nYou can talk to me by typing or sending voice messages — whichever you're more comfortable with.\n\nI'll remember the stories you share with me.\n\nWould you like to tell me a little about yourself, or should I just start asking?`;

const WELCOME_ES = (n: string) =>
  `¡Bienvenido, ${n}! Soy tu compañero StoryKeeper.\n\nPuedes hablarme escribiendo o enviando mensajes de voz — lo que te sea más cómodo.\n\nRecordaré las historias que compartas conmigo.\n\n¿Te gustaría contarme un poco sobre ti, o debería empezar a preguntar?`;

// ── Channel ────────────────────────────────────────────────────────────────

export class StoryKeeperTelegramChannel extends TelegramChannel {

  async connect(): Promise<void> {
    await super.connect();

    const self = this as unknown as Record<string, unknown>;
    const bot = self.bot as import('grammy').Bot | null;
    if (!bot) {
      logger.error('StoryKeeper: bot not initialized');
      return;
    }

    // /start — Setup flow
    bot.command('start', async (ctx) => {
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      const existing = await getUserProfile(userId);
      if (existing) {
        const lang = ((existing.language as string) || 'en') as 'en' | 'es';
        const name = ((existing.preferred_name as string) || (existing.first_name as string)) || 'there';
        await ctx.reply(lang === 'es' ? WELCOME_ES(name) : WELCOME_EN(name));
        return;
      }

      await ctx.reply("Hi! I'm your StoryKeeper companion. I'd love to get to know you.\n\nWhat should I call you?");
      setupStates.set(userId, { step: 'awaiting_name' });
    });

    // Text handler: language switch + setup flow
    bot.on('message:text', async (ctx) => {
      const text = ctx.message?.text?.trim().toLowerCase();
      const userId = ctx.from?.id?.toString();
      if (!text || !userId) return;

      if (['english', 'inglés', 'ingles'].includes(text)) {
        await updateUserLanguage(userId, 'en');
        await ctx.reply("Got it — I'll speak in English from now on.");
        return;
      }
      if (['español', 'spanish', 'espanol'].includes(text)) {
        await updateUserLanguage(userId, 'es');
        await ctx.reply("¡Entendido! Ahora hablaré en español.");
        return;
      }

      const state = setupStates.get(userId);
      if (!state) return;

      if (state.step === 'awaiting_name') {
        const name = ctx.message!.text!.trim();
        if (name.length < 1 || name.length > 50) {
          await ctx.reply("That doesn't look quite right. What should I call you?");
          return;
        }
        state.name = name;
        state.step = 'awaiting_language';
        await ctx.reply(`Nice to meet you, ${name}!\n\nWould you like to talk in English or Spanish?\n(Just say "English" or "Español")`);
        return;
      }

      if (state.step === 'awaiting_language') {
        const raw = ctx.message!.text!.trim().toLowerCase();
        const language = ['español', 'spanish', 'espanol'].some(k => raw.includes(k)) ? 'es' : 'en';
        const created = await createUserProfile(userId, state.name!, language);
        if (created) {
          await ctx.reply(language === 'es' ? WELCOME_ES(state.name!) : WELCOME_EN(state.name!));
          logger.info({ userId, name: state.name, language }, 'New user setup complete');
        } else {
          await ctx.reply("I'm having a little trouble setting things up right now. Let me try again in a moment. You can type /start to begin.");
          logger.error({ userId }, 'Failed to create user profile');
        }
        setupStates.delete(userId);
        return;
      }

      setupStates.delete(userId);
    });

    // Voice handler override — route to IPC instead of attachments
    bot.on('message:voice', async (ctx) => {
      const voice = ctx.message?.voice;
      if (!voice) return;
      const userId = ctx.from?.id?.toString();
      const chatJid = `tg:${ctx.chat.id}`;
      if (!userId) return;

      const parentOpts = self.opts as {
        registeredGroups: () => Record<string, { folder: string }>;
        onMessage: (chatJid: string, msg: Record<string, unknown>) => void;
      } | undefined;
      const groups = parentOpts?.registeredGroups?.();
      if (groups && !groups[chatJid]) return;

      if (voice.file_size && voice.file_size < MIN_VOICE_BYTES) {
        await ctx.reply("I didn't catch much there — could you hold the button a bit longer?");
        return;
      }

      try {
        const file = await ctx.api.getFile(voice.file_id);
        if (!file.file_path) {
          await ctx.reply("I'm sorry, I couldn't quite hear that. Could you try again?");
          return;
        }

        const token = self.botToken as string;
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        if (!resp.ok) {
          await ctx.reply("I'm sorry, I couldn't quite hear that. Could you try again?");
          return;
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        const group = groups?.[chatJid];
        const groupFolder = group?.folder || 'default';
        const groupDir = resolveGroupFolderPath(groupFolder);
        const voiceInDir = path.join(groupDir, 'ipc', 'voice', 'in');
        fs.mkdirSync(voiceInDir, { recursive: true });

        const voiceFilename = `voice_${Date.now()}.ogg`;
        fs.writeFileSync(path.join(voiceInDir, voiceFilename), buffer);
        logger.info({ userId, chatJid, voiceFile: voiceFilename, size: buffer.length }, 'Voice → IPC');

        await ctx.api.sendChatAction(ctx.chat.id, 'typing');

        const containerVoicePath = `/workspace/group/ipc/voice/in/${voiceFilename}`;
        if (parentOpts?.onMessage) {
          parentOpts.onMessage(chatJid, {
            id: ctx.message!.message_id.toString(),
            chat_jid: chatJid,
            sender: userId,
            sender_name: ctx.from?.first_name || userId,
            content: `voice:${containerVoicePath}`,
            timestamp: new Date(ctx.message!.date * 1000).toISOString(),
            is_from_me: false,
          });
        }
        return;
      } catch (err) {
        logger.error({ userId, err }, 'Voice processing error');
        await ctx.reply("I'm sorry, I couldn't quite hear that. Could you try again? You can also type if that's easier.");
        return;
      }
    });

    logger.info('StoryKeeper Telegram extensions loaded');
  }

  async sendMessage(jid: string, text: string, threadId?: string): Promise<void> {
    const cleanText = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
    if (!cleanText) return;

    // Voice response from container
    if (cleanText.includes(VOICE_MARKER) && cleanText.includes(TRANSCRIPT_MARKER)) {
      const vi = cleanText.indexOf(VOICE_MARKER);
      const ti = cleanText.indexOf(TRANSCRIPT_MARKER);
      if (vi !== -1 && ti !== -1) {
        const audioPath = cleanText.slice(vi + VOICE_MARKER.length, ti).trim();
        const transcript = cleanText.slice(ti + TRANSCRIPT_MARKER.length).trim();
        if (audioPath && fs.existsSync(audioPath)) {
          try {
            await this.sendVoice(jid, audioPath, transcript || undefined, threadId);
            try { fs.unlinkSync(audioPath); } catch { /* ok */ }
            return;
          } catch (err) {
            logger.warn({ jid, err }, 'Voice send failed, falling back to text');
          }
        }
        if (transcript) {
          await this.sendChunked(jid, transcript, threadId);
          return;
        }
      }
    }

    const finalText = cleanText.replace(/__VOICE__\S*/g, '').replace(/__TRANSCRIPT__/g, '').trim();
    if (finalText) {
      await this.sendChunked(jid, finalText, threadId);
    }
  }

  private async sendChunked(jid: string, text: string, threadId?: string): Promise<void> {
    if (text.split(/\s+/).length <= MAX_WORDS) {
      await super.sendMessage(jid, text, threadId);
      return;
    }

    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let chunk = '';
    for (const sentence of sentences) {
      const test = chunk + sentence;
      if (test.split(/\s+/).length > MAX_WORDS && chunk.trim()) {
        await super.sendMessage(jid, chunk.trim(), threadId);
        await sleep(CHUNK_DELAY_MS);
        chunk = sentence;
      } else {
        chunk = test;
      }
    }
    if (chunk.trim()) await super.sendMessage(jid, chunk.trim(), threadId);
  }

  private async sendVoice(jid: string, audioPath: string, caption?: string, threadId?: string): Promise<void> {
    const bot = (this as unknown as Record<string, unknown>).bot as import('grammy').Bot | null;
    if (!bot) return;
    const numericId = jid.replace(/^tg:/, '');
    const opts: Record<string, unknown> = {};
    if (threadId) opts.message_thread_id = parseInt(threadId, 10);
    if (caption) opts.caption = caption;
    await bot.api.sendVoice(numericId, new InputFile(audioPath), opts as any);
    logger.info({ jid, audioPath }, 'Voice sent');
  }
}

// Register as 'telegram' — overrides base NanoClaw Telegram channel (last set wins)
registerChannel('telegram', (opts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) { logger.warn('StoryKeeper Telegram: TELEGRAM_BOT_TOKEN not set'); return null; }
  return new StoryKeeperTelegramChannel(token, opts);
});
