import express, { type Request, type Response } from 'express';
import type { Sender } from './channels/types.js';
import { extractTelegramMessage } from './channels/telegram.js';
import { extractWhatsAppMessages, verifyMetaSignature } from './channels/whatsapp.js';
import type { OrderBot } from './engine.js';
import { verifyStripeSignature } from './payments.js';
import type { ChannelName, Order, OrderStore } from './store.js';

export interface AppDeps {
  bot: OrderBot;
  store: OrderStore;
  senders: Partial<Record<ChannelName, Sender>>;
  whatsapp?: { verifyToken?: string; appSecret?: string };
  /** Present when Telegram runs in webhook mode. */
  telegramWebhook?: { secret?: string };
  stripeWebhookSecret?: string;
  /** Enables GET /mock-pay/:reference (only when no real payment provider is configured). */
  mockPayments?: boolean;
  adminToken?: string;
}

type RawRequest = Request & { rawBody?: Buffer };

interface StripeEvent {
  type?: string;
  data?: {
    object?: {
      client_reference_id?: string | null;
      amount_total?: number | null;
      currency?: string | null;
      payment_status?: string;
    };
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`;

export function buildApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Keep the raw bytes: webhook signatures are computed over the exact body that was sent.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as RawRequest).rawBody = Buffer.from(buf);
      },
    }),
  );

  const background = (label: string, task: () => Promise<unknown>) => {
    task().catch((err) => console.error(`[${label}]`, err));
  };

  const respond = async (channel: ChannelName, userId: string, text: string) => {
    const replies = await deps.bot.handle(channel, userId, text);
    await deps.senders[channel]?.send(userId, replies);
  };

  const notifyPaid = async (order: Order) => {
    await deps.senders[order.channel]?.send(order.userId, [deps.bot.paymentConfirmedReply(order)]);
  };

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // --- WhatsApp Cloud API ---
  if (deps.senders.whatsapp) {
    app.get('/whatsapp/webhook', (req, res) => {
      const verifyToken = deps.whatsapp?.verifyToken;
      if (req.query['hub.mode'] === 'subscribe' && verifyToken && req.query['hub.verify_token'] === verifyToken) {
        res.status(200).send(String(req.query['hub.challenge'] ?? ''));
        return;
      }
      res.sendStatus(403);
    });

    app.post('/whatsapp/webhook', (req: RawRequest, res: Response) => {
      const secret = deps.whatsapp?.appSecret;
      if (secret && !verifyMetaSignature(req.rawBody ?? Buffer.alloc(0), req.get('x-hub-signature-256'), secret)) {
        res.sendStatus(401);
        return;
      }
      // Acknowledge first: Meta retries webhooks that take too long to answer.
      res.sendStatus(200);
      for (const msg of extractWhatsAppMessages(req.body)) {
        background('whatsapp', () => respond('whatsapp', msg.userId, msg.text));
      }
    });
  }

  // --- Telegram (webhook mode) ---
  if (deps.senders.telegram && deps.telegramWebhook) {
    app.post('/telegram/webhook', (req, res) => {
      const secret = deps.telegramWebhook?.secret;
      if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) {
        res.sendStatus(401);
        return;
      }
      res.sendStatus(200);
      const msg = extractTelegramMessage(req.body);
      if (msg) background('telegram', () => respond('telegram', msg.userId, msg.text));
    });
  }

  // --- Stripe ---
  if (deps.stripeWebhookSecret) {
    const secret = deps.stripeWebhookSecret;
    app.post('/stripe/webhook', (req: RawRequest, res: Response) => {
      if (!verifyStripeSignature(req.rawBody ?? Buffer.alloc(0), req.get('stripe-signature'), secret)) {
        res.sendStatus(400);
        return;
      }
      res.sendStatus(200);
      const event = req.body as StripeEvent;
      const session = event.data?.object;
      const completes =
        event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded';
      if (!completes || session?.payment_status !== 'paid' || !session.client_reference_id) return;
      const reference = session.client_reference_id;
      background('stripe', async () => {
        const order = await deps.bot.markPaid(reference, {
          amount: session.amount_total ?? undefined,
          currency: session.currency ?? undefined,
        });
        if (order) await notifyPaid(order);
      });
    });
  }

  app.get('/paid', (_req, res) => {
    res.type('html').send(page('Thank you!', 'Your payment went through. You can close this page and go back to the chat.'));
  });
  app.get('/cancelled', (_req, res) => {
    res.type('html').send(page('Payment cancelled', 'No money was taken. Go back to the chat and type STATUS to get your payment link again.'));
  });

  // --- Demo payments (no Stripe key) ---
  if (deps.mockPayments) {
    app.get('/mock-pay/:reference', async (req, res) => {
      try {
        const order = await deps.bot.markPaid(req.params.reference);
        if (order) await notifyPaid(order);
        res
          .type('html')
          .send(
            order
              ? page('Demo payment complete', `Order ${order.reference} is now marked as paid. Check the chat for the confirmation.`)
              : page('Nothing to pay', 'This order was not found or has already been paid.'),
          );
      } catch (err) {
        console.error('[mock-pay]', err);
        res.status(500).type('html').send(page('Something went wrong', 'Please try again.'));
      }
    });
  }

  // --- Admin ---
  app.get('/orders', async (req, res) => {
    if (!deps.adminToken) {
      res.sendStatus(404);
      return;
    }
    if (req.get('x-admin-token') !== deps.adminToken) {
      res.sendStatus(401);
      return;
    }
    try {
      res.json(await deps.store.list());
    } catch (err) {
      console.error('[orders]', err);
      res.sendStatus(500);
    }
  });

  return app;
}
