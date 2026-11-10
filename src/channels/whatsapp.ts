import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Reply } from '../engine.js';
import type { Sender } from './types.js';

export interface WhatsAppOptions {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}

export interface IncomingMessage {
  userId: string;
  text: string;
}

// WhatsApp limits: up to 3 reply buttons, 20 characters per title, 1024 characters of body text.
const MAX_BUTTONS = 3;
const MAX_TITLE = 20;
const MAX_INTERACTIVE_BODY = 1024;

/** Sends messages through the WhatsApp Cloud API. */
export class WhatsAppChannel implements Sender {
  constructor(private readonly opts: WhatsAppOptions) {}

  async send(to: string, replies: Reply[]): Promise<void> {
    for (const reply of replies) {
      await this.post(buildWhatsAppPayload(to, reply));
    }
  }

  private async post(payload: unknown): Promise<void> {
    const { graphVersion, phoneNumberId, token } = this.opts;
    const res = await (this.opts.fetchImpl ?? fetch)(
      `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      throw new Error(`WhatsApp send failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
  }
}

export function buildWhatsAppPayload(to: string, reply: Reply): unknown {
  const buttons = reply.buttons ?? [];
  const fitsInteractive =
    buttons.length > 0 &&
    buttons.length <= MAX_BUTTONS &&
    buttons.every((b) => b.length <= MAX_TITLE) &&
    reply.text.length <= MAX_INTERACTIVE_BODY;

  if (fitsInteractive) {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: reply.text },
        action: {
          buttons: buttons.map((title, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title } })),
        },
      },
    };
  }

  const options = buttons.length > 0 ? `\n\nReply with: ${buttons.join(' / ')}` : '';
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: reply.text + options, preview_url: true },
  };
}

/** Pulls customer messages out of a WhatsApp webhook payload. Status updates are ignored. */
export function extractWhatsAppMessages(body: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const entries = (body as { entry?: unknown[] } | undefined)?.entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } }).value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const m of messages as Array<Record<string, any>>) {
        const text: unknown =
          m.text?.body ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          m.button?.text;
        if (typeof m.from === 'string' && typeof text === 'string' && text.trim() !== '') {
          out.push({ userId: m.from, text });
        }
      }
    }
  }
  return out;
}

/** Checks Meta's X-Hub-Signature-256 header ("sha256=<hex>") against the raw request body. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(header.slice('sha256='.length), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
