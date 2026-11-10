import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.js';
import type { Reply } from '../src/engine.js';
import { CHECKOUT_FLOW, say, setup } from './helpers.js';

const STRIPE_SECRET = 'whsec_test';
const META_SECRET = 'meta_secret';

const { bot, store } = setup();
const sent: Array<{ channel: string; userId: string; replies: Reply[] }> = [];
const sender = (channel: string) => ({
  send: async (userId: string, replies: Reply[]) => {
    sent.push({ channel, userId, replies });
  },
});

let server: Server;
let base: string;

before(async () => {
  const app = buildApp({
    bot,
    store,
    senders: { whatsapp: sender('whatsapp'), cli: sender('cli') },
    whatsapp: { verifyToken: 'verify-me', appSecret: META_SECRET },
    stripeWebhookSecret: STRIPE_SECRET,
    mockPayments: true,
    adminToken: 'admin',
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}

test('WhatsApp webhook verification handshake', async () => {
  const ok = await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '123');
  const bad = await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123`);
  assert.equal(bad.status, 403);
});

test('signed WhatsApp messages get a reply; unsigned ones are rejected', async () => {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '4477', text: { body: 'hi' } }] } }] }] });
  const sig = `sha256=${createHmac('sha256', META_SECRET).update(body).digest('hex')}`;

  const unsigned = await fetch(`${base}/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unsigned.status, 401);

  const res = await fetch(`${base}/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    body,
  });
  assert.equal(res.status, 200);
  const reply = await waitFor(() => sent.find((s) => s.channel === 'whatsapp' && s.userId === '4477'));
  assert.match(reply.replies[0]!.text, /Welcome to Test Bakery/);
});

test('Stripe webhook marks the order paid once and notifies the customer', async () => {
  await say(bot, ...CHECKOUT_FLOW, 'yes');
  const order = await store.findByReference('ORD-ID1');
  assert.equal(order?.status, 'pending_payment');

  const body = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'ORD-ID1', amount_total: order!.total, currency: 'gbp', payment_status: 'paid' } },
  });
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${createHmac('sha256', STRIPE_SECRET).update(`${t}.${body}`).digest('hex')}`;
  const post = () =>
    fetch(`${base}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body });

  const forged = await fetch(`${base}/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=00` },
    body,
  });
  assert.equal(forged.status, 400);

  assert.equal((await post()).status, 200);
  await waitFor(async () => (await store.findByReference('ORD-ID1'))?.status === 'paid');
  assert.equal((await post()).status, 200); // Stripe retry

  await new Promise((r) => setTimeout(r, 100));
  const confirmations = sent.filter((s) => s.channel === 'cli' && /Payment received/.test(s.replies[0]!.text));
  assert.equal(confirmations.length, 1);
});

test('mock payment page marks an order paid', async () => {
  const replies = await bot.handle('cli', 'u2', 'menu');
  assert.ok(replies.length);
  for (const m of ['2', '1', 'Checkout', 'Grace', '2 Low Road, Leeds', 'yes']) await bot.handle('cli', 'u2', m);
  const order = await store.latestForUser('cli', 'u2');
  assert.ok(order);

  const res = await fetch(`${base}/mock-pay/${order.reference}`);
  assert.match(await res.text(), /Demo payment complete/);
  assert.equal((await store.findByReference(order.reference))?.status, 'paid');
  assert.match(await (await fetch(`${base}/mock-pay/${order.reference}`)).text(), /already been paid/);
});

test('orders endpoint requires the admin token', async () => {
  assert.equal((await fetch(`${base}/orders`)).status, 401);
  const res = await fetch(`${base}/orders`, { headers: { 'x-admin-token': 'admin' } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});
