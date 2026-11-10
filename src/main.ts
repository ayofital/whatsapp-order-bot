import { join } from 'node:path';
import { buildApp } from './app.js';
import { loadCatalog } from './catalog.js';
import { TelegramChannel } from './channels/telegram.js';
import type { Sender } from './channels/types.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { config } from './config.js';
import { OrderBot, type PaymentProvider } from './engine.js';
import { MockPaymentProvider, StripeProvider } from './payments.js';
import { OrderRepository, type ChannelName } from './store.js';

const catalog = loadCatalog(join(config.dataDir, 'catalog.json'));
const store = new OrderRepository(join(config.dataDir, 'orders.json'));

const useStripe = Boolean(config.stripe.secretKey);
const payments: PaymentProvider = useStripe
  ? new StripeProvider(config.stripe.secretKey!, {
      successUrl: config.stripe.successUrl,
      cancelUrl: config.stripe.cancelUrl,
    })
  : new MockPaymentProvider(config.publicUrl);
if (useStripe && !config.stripe.webhookSecret) {
  console.warn('[stripe] STRIPE_WEBHOOK_SECRET is not set, so paid orders will never be marked as paid.');
}

const bot = new OrderBot({ catalog, store, payments });
const senders: Partial<Record<ChannelName, Sender>> = {};

const telegram = config.telegram.token ? new TelegramChannel(config.telegram.token) : undefined;
if (telegram) senders.telegram = telegram;

const { whatsapp: wa } = config;
if (wa.token && wa.phoneNumberId) {
  senders.whatsapp = new WhatsAppChannel({ token: wa.token, phoneNumberId: wa.phoneNumberId, graphVersion: wa.graphVersion });
  if (!wa.verifyToken) console.warn('[whatsapp] WHATSAPP_VERIFY_TOKEN is not set, so Meta cannot verify the webhook.');
  if (!wa.appSecret) console.warn('[whatsapp] WHATSAPP_APP_SECRET is not set, so webhook signatures are not checked.');
}

const app = buildApp({
  bot,
  store,
  senders,
  whatsapp: { verifyToken: wa.verifyToken, appSecret: wa.appSecret },
  telegramWebhook: telegram && config.telegram.mode === 'webhook' ? { secret: config.telegram.webhookSecret } : undefined,
  stripeWebhookSecret: config.stripe.webhookSecret,
  mockPayments: !useStripe,
  adminToken: config.adminToken,
});

const stopPolling = new AbortController();

const server = app.listen(config.port, () => {
  console.log(`${catalog.businessName} bot listening on ${config.publicUrl} (port ${config.port})`);
  console.log(`Payments: ${useStripe ? 'Stripe Checkout' : 'mock links (set STRIPE_SECRET_KEY for real payments)'}`);
  if (senders.whatsapp) console.log(`WhatsApp webhook: ${config.publicUrl}/whatsapp/webhook`);

  if (telegram && config.telegram.mode === 'webhook') {
    telegram
      .setWebhook(`${config.publicUrl}/telegram/webhook`, config.telegram.webhookSecret)
      .then(() => console.log(`Telegram webhook set to ${config.publicUrl}/telegram/webhook`))
      .catch((err) => console.error('[telegram] could not set webhook:', err));
  } else if (telegram) {
    console.log('Telegram: long polling. Message your bot now.');
    void telegram.startPolling(async ({ userId, text }) => {
      await telegram.send(userId, await bot.handle('telegram', userId, text));
    }, stopPolling.signal);
  }

  if (!telegram && !senders.whatsapp) {
    console.log('No chat channel configured. Run `npm run chat` to try the bot in your terminal.');
  }
});

const shutdown = () => {
  stopPolling.abort();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
