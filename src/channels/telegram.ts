import type { Reply } from '../engine.js';
import type { Sender } from './types.js';

export interface IncomingMessage {
  userId: string;
  text: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id?: number }; text?: string };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Talks to the Telegram Bot API. Supports long polling (local dev) and webhooks (production). */
export class TelegramChannel implements Sender {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(chatId: string, replies: Reply[]): Promise<void> {
    for (const reply of replies) {
      await this.call('sendMessage', buildTelegramPayload(chatId, reply));
    }
  }

  async setWebhook(url: string, secretToken?: string): Promise<void> {
    await this.call('setWebhook', {
      url,
      allowed_updates: ['message'],
      ...(secretToken ? { secret_token: secretToken } : {}),
    });
  }

  /**
   * Long-polls for messages until `signal` is aborted. Each message is handed to
   * `onMessage`; a failure there is logged and never stops the loop.
   */
  async startPolling(onMessage: (msg: IncomingMessage) => Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.call('deleteWebhook', {}); // getUpdates is refused while a webhook is set
    let offset = 0;
    while (!signal?.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, signal);
      } catch (err) {
        if (signal?.aborted) return;
        console.error('[telegram] polling failed, retrying in 3s:', (err as Error).message);
        await sleep(3000);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = extractTelegramMessage(update);
        if (!msg) continue;
        await onMessage(msg).catch((err) => console.error('[telegram] handling message failed:', err));
      }
    }
  }

  private async call<T = unknown>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => undefined)) as
      | { ok?: boolean; result?: T; description?: string }
      | undefined;
    if (!res.ok || !json?.ok) {
      throw new Error(`Telegram ${method} failed (${res.status}): ${json?.description ?? 'no description'}`);
    }
    return json.result as T;
  }
}

export function buildTelegramPayload(chatId: string, reply: Reply): Record<string, unknown> {
  const buttons = reply.buttons ?? [];
  return {
    chat_id: chatId,
    text: reply.text,
    reply_markup:
      buttons.length > 0
        ? { keyboard: buttons.map((text) => [{ text }]), resize_keyboard: true, one_time_keyboard: true }
        : { remove_keyboard: true },
  };
}

export function extractTelegramMessage(update: unknown): IncomingMessage | undefined {
  const message = (update as TelegramUpdate | undefined)?.message;
  const chatId = message?.chat?.id;
  if (typeof chatId !== 'number' || typeof message?.text !== 'string' || message.text.trim() === '') return undefined;
  return { userId: String(chatId), text: message.text };
}
