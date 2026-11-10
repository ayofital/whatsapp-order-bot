import type { Catalog } from '../src/catalog.js';
import { OrderBot, type PaymentProvider, type Reply } from '../src/engine.js';
import { OrderRepository } from '../src/store.js';

export const catalog: Catalog = {
  businessName: 'Test Bakery',
  currency: 'GBP',
  deliveryFee: 350,
  products: [
    { id: 'sourdough', name: 'Sourdough Loaf', unitAmount: 550 },
    { id: 'buns', name: 'Cinnamon Buns', unitAmount: 1400 },
  ],
  faq: [{ keywords: ['open', 'hours'], answer: 'We open 7am to 4pm.' }],
};

export function setup(payments?: PaymentProvider) {
  const store = new OrderRepository();
  let n = 0;
  const bot = new OrderBot({
    catalog,
    store,
    payments: payments ?? { createPaymentLink: async (o) => `https://pay.test/${o.reference}` },
    newId: () => `ID${++n}`,
    now: () => new Date('2026-11-10T12:00:00Z'),
  });
  return { bot, store };
}

/** Sends messages in order and returns the replies to the last one. */
export async function say(bot: OrderBot, ...messages: string[]): Promise<Reply[]> {
  let last: Reply[] = [];
  for (const m of messages) last = await bot.handle('cli', 'u1', m);
  return last;
}

export const CHECKOUT_FLOW = ['hi', 'menu', '1', '2', 'Checkout', 'Ada Lovelace', '1 High Street, London N1 1AA'];
