import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUTTONS } from '../src/engine.js';
import { CHECKOUT_FLOW, say, setup } from './helpers.js';

test('a full order creates a pending order with the right total and a payment link', async () => {
  const { bot, store } = setup();
  const replies = await say(
    bot,
    'hi', 'menu', '1', '2', 'Add more', '2', '3', 'Checkout',
    'Ada Lovelace', '1 High Street, London N1 1AA', BUTTONS.yes,
  );

  assert.match(replies[0]!.text, /Order ORD-ID1 placed/);
  assert.match(replies[0]!.text, /https:\/\/pay\.test\/ORD-ID1/);

  const [order] = await store.list();
  assert.ok(order);
  assert.equal(order.total, 2 * 550 + 3 * 1400 + 350);
  assert.equal(order.status, 'pending_payment');
  assert.equal(order.customerName, 'Ada Lovelace');
  assert.equal(order.currency, 'GBP');
  assert.deepEqual(order.lines.map((l) => [l.productId, l.qty]), [['sourdough', 2], ['buns', 3]]);
});

test('ordering the same item twice merges it into one line', async () => {
  const { bot, store } = setup();
  await say(bot, 'menu', '1', '2', 'Add more', '1', '1', ...CHECKOUT_FLOW.slice(4), 'yes');
  const [order] = await store.list();
  assert.deepEqual(order?.lines.map((l) => l.qty), [3]);
});

test('products can be picked by name as well as number', async () => {
  const { bot } = setup();
  const replies = await say(bot, 'menu', 'cinnamon');
  assert.match(replies[0]!.text, /How many "Cinnamon Buns"/);
});

test('invalid item numbers and quantities are rejected with a hint', async () => {
  const { bot } = setup();
  assert.match((await say(bot, 'menu', '9'))[0]!.text, /number from 1 to 2/);
  await say(bot, '1');
  for (const bad of ['0', '51', 'two', '-1']) {
    assert.match((await say(bot, bad))[0]!.text, /number from 1 to 50/, `quantity "${bad}"`);
  }
  assert.match((await say(bot, '50'))[0]!.text, /Added 50 × Sourdough Loaf/);
});

test('cancel empties the basket at any step', async () => {
  const { bot, store } = setup();
  await say(bot, 'menu', '1', '2', 'Checkout', 'Ada');
  assert.match((await say(bot, 'cancel'))[0]!.text, /cancelled/);
  assert.match((await say(bot, 'checkout'))[0]!.text, /didn't catch/);
  assert.equal((await store.list()).length, 0);
});

test('"No, go back" at confirmation keeps the basket', async () => {
  const { bot } = setup();
  await say(bot, ...CHECKOUT_FLOW);
  const back = await say(bot, BUTTONS.no);
  assert.match(back[0]!.text, /basket is saved/);
  const again = await say(bot, 'Checkout', 'Ada', '1 High Street, London');
  assert.match(again[0]!.text, /2 × Sourdough Loaf/);
});

test('FAQ answers work when idle and mid-order, but not while typing a name or address', async () => {
  const { bot } = setup();
  assert.equal((await say(bot, 'what time are you open?'))[0]!.text, 'We open 7am to 4pm.');

  await say(bot, 'menu', '1', '1');
  const mid = await say(bot, 'what are your hours');
  assert.equal(mid[0]!.text, 'We open 7am to 4pm.');
  assert.deepEqual(mid[0]!.buttons, [BUTTONS.addMore, BUTTONS.checkout, BUTTONS.cancel]);

  await say(bot, 'Checkout', 'Ada');
  const address = await say(bot, 'Open Road House, London');
  assert.match(address[0]!.text, /Please confirm your order/);
});

test('a failed payment link keeps the order unplaced and lets the customer retry', async () => {
  let calls = 0;
  const { bot, store } = setup({
    createPaymentLink: async (o) => {
      calls++;
      if (calls === 1) throw new Error('provider down');
      return `https://pay.test/${o.reference}`;
    },
  });
  const failed = await say(bot, ...CHECKOUT_FLOW, 'yes');
  assert.match(failed[0]!.text, /couldn't create your payment link/);
  assert.equal((await store.list()).length, 0);

  const ok = await say(bot, 'yes');
  assert.match(ok[0]!.text, /placed/);
  assert.equal((await store.list()).length, 1);
});

test('markPaid checks amount and currency and only succeeds once', async () => {
  const { bot } = setup();
  await say(bot, ...CHECKOUT_FLOW, 'yes');
  const total = 2 * 550 + 350;

  assert.equal(await bot.markPaid('ORD-ID1', { amount: total - 1 }), undefined);
  assert.equal(await bot.markPaid('ORD-ID1', { amount: total, currency: 'usd' }), undefined);
  assert.equal(await bot.markPaid('ORD-NOPE'), undefined);

  const paid = await bot.markPaid('ORD-ID1', { amount: total, currency: 'gbp' });
  assert.equal(paid?.status, 'paid');
  assert.equal(paid?.paidAt, '2026-11-10T12:00:00.000Z');
  assert.equal(await bot.markPaid('ORD-ID1', { amount: total }), undefined, 'second webhook is ignored');

  assert.match((await say(bot, 'status'))[0]!.text, /is paid/);
});

test('status shows the payment link while unpaid', async () => {
  const { bot } = setup();
  assert.match((await say(bot, 'status'))[0]!.text, /don't have any orders/);
  await say(bot, ...CHECKOUT_FLOW, 'yes');
  assert.match((await say(bot, 'status'))[0]!.text, /waiting for payment\.\nPay here: https:\/\/pay\.test\/ORD-ID1/);
});

test('messages from one customer are handled in order even when they arrive together', async () => {
  const { bot } = setup();
  const [menu, qty] = await Promise.all([bot.handle('cli', 'u1', 'menu'), bot.handle('cli', 'u1', '2')]);
  assert.match(menu[0]!.text, /menu/);
  assert.match(qty[0]!.text, /How many "Cinnamon Buns"/);
});

test('customers do not share baskets', async () => {
  const { bot } = setup();
  await bot.handle('cli', 'alice', 'menu');
  await bot.handle('cli', 'alice', '1');
  const bob = await bot.handle('cli', 'bob', '3');
  assert.match(bob[0]!.text, /didn't catch/);
});
