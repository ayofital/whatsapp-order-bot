import 'dotenv/config';

function opt(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const port = Number(opt('PORT') ?? 3000);
const publicUrl = (opt('PUBLIC_URL') ?? `http://localhost:${port}`).replace(/\/$/, '');
const telegramMode = opt('TELEGRAM_MODE') ?? 'polling';
if (telegramMode !== 'polling' && telegramMode !== 'webhook') {
  throw new Error('TELEGRAM_MODE must be "polling" or "webhook"');
}

export const config = {
  port,
  publicUrl,
  dataDir: opt('DATA_DIR') ?? 'data',
  adminToken: opt('ADMIN_TOKEN'),
  telegram: {
    token: opt('TELEGRAM_BOT_TOKEN'),
    mode: telegramMode as 'polling' | 'webhook',
    webhookSecret: opt('TELEGRAM_WEBHOOK_SECRET'),
  },
  whatsapp: {
    token: opt('WHATSAPP_TOKEN'),
    phoneNumberId: opt('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: opt('WHATSAPP_VERIFY_TOKEN'),
    appSecret: opt('WHATSAPP_APP_SECRET'),
    graphVersion: opt('WHATSAPP_GRAPH_VERSION') ?? 'v21.0',
  },
  stripe: {
    secretKey: opt('STRIPE_SECRET_KEY'),
    webhookSecret: opt('STRIPE_WEBHOOK_SECRET'),
    successUrl: opt('STRIPE_SUCCESS_URL') ?? `${publicUrl}/paid`,
    cancelUrl: opt('STRIPE_CANCEL_URL') ?? `${publicUrl}/cancelled`,
  },
};
