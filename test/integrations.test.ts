import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatMoney, parseCatalog } from '../src/catalog.js';
import { buildTelegramPayload, extractTelegramMessage } from '../src/channels/telegram.js';
import { buildWhatsAppPayload, extractWhatsAppMessages, verifyMetaSignature } from '../src/channels/whatsapp.js';
import { StripeProvider, verifyStripeSignature } from '../src/payments.js';
import { OrderRepository, type Order } from '../src/store.js';

const order: Order = {
  id: 'ABC',
  reference: 'ORD-ABC',
  channel: 'whatsapp',
  userId: '447700900000',
  customerName: 'Ada',
  address: '1 High Street',
  currency: 'GBP',
  lines: [{ productId: 'sourdough', name: 'Sourdough Loaf', unitAmount: 550, qty: 2 }],
  deliveryFee: 350,
  total: 1450,
  status: 'pending_payment',
  createdAt: '2026-11-10T12:00:00.000Z',
};

const stripeHeader = (body: string, secret: string, t: number) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('catalog converts prices to minor units and validates input', () => {
  const c = parseCatalog(
    JSON.stringify({ businessName: 'B', currency: 'usd', deliveryFee: 2.5, products: [{ id: 'a', name: 'A', price: 5.99 }] }),
  );
  assert.equal(c.currency, 'USD');
  assert.equal(c.deliveryFee, 250);
  assert.equal(c.products[0]?.unitAmount, 599);
  assert.throws(() => parseCatalog('{"businessName":"B","currency":"GBP","products":[]}'), /non-empty/);
  assert.throws(
    () => parseCatalog('{"businessName":"B","currency":"GBP","products":[{"id":"a","name":"A","price":-1}]}'),
    /non-negative/,
  );
  assert.equal(formatMoney(1450, 'GBP'), '£14.50');
});

test('the shipped sample catalog loads', async () => {
  const c = parseCatalog(await readFile(join('data', 'catalog.json'), 'utf8'));
  assert.ok(c.products.length > 0);
});

test('Stripe checkout request carries every line, delivery, reference and idempotency key', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 });
  }) as typeof fetch;

  const provider = new StripeProvider('sk_test_x', { successUrl: 'https://s', cancelUrl: 'https://c', fetchImpl: fakeFetch });
  assert.equal(await provider.createPaymentLink(order), 'https://checkout.stripe.com/c/pay/cs_test_1');

  assert.equal(captured?.url, 'https://api.stripe.com/v1/checkout/sessions');
  const headers = captured?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk_test_x');
  assert.equal(headers['Idempotency-Key'], 'checkout-ORD-ABC');
  const form = new URLSearchParams(String(captured?.init.body));
  assert.equal(form.get('client_reference_id'), 'ORD-ABC');
  assert.equal(form.get('line_items[0][quantity]'), '2');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '550');
  assert.equal(form.get('line_items[0][price_data][currency]'), 'gbp');
  assert.equal(form.get('line_items[1][price_data][product_data][name]'), 'Delivery');
  assert.equal(form.get('line_items[1][price_data][unit_amount]'), '350');
});

test('Stripe errors surface the API message', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 })) as unknown as typeof fetch;
  const provider = new StripeProvider('bad', { successUrl: 's', cancelUrl: 'c', fetchImpl: fakeFetch });
  await assert.rejects(provider.createPaymentLink(order), /401.*Invalid API Key/);
});

test('Stripe signatures: valid, tampered, wrong secret, stale, malformed', () => {
  const body = '{"type":"checkout.session.completed"}';
  const now = 1_800_000_000;
  const header = stripeHeader(body, 'whsec_1', now);
  assert.equal(verifyStripeSignature(Buffer.from(body), header, 'whsec_1', 300, now), true);
  assert.equal(verifyStripeSignature(Buffer.from(body + ' '), header, 'whsec_1', 300, now), false);
  assert.equal(verifyStripeSignature(Buffer.from(body), header, 'whsec_2', 300, now), false);
  assert.equal(verifyStripeSignature(Buffer.from(body), header, 'whsec_1', 300, now + 301), false);
  assert.equal(verifyStripeSignature(Buffer.from(body), 'garbage', 'whsec_1', 300, now), false);
  assert.equal(verifyStripeSignature(Buffer.from(body), undefined, 'whsec_1', 300, now), false);
  // Stripe may send several v1 signatures while rotating secrets.
  assert.equal(verifyStripeSignature(Buffer.from(body), `${header},v1=deadbeef`, 'whsec_1', 300, now), true);
});

test('WhatsApp: extracts text and button replies, ignores status updates', () => {
  const body = {
    entry: [
      {
        changes: [
          { value: { statuses: [{ id: 'x' }] } },
          {
            value: {
              messages: [
                { from: '111', type: 'text', text: { body: 'hi' } },
                { from: '222', type: 'interactive', interactive: { button_reply: { id: 'btn_1', title: 'Checkout' } } },
                { from: '333', type: 'image', image: {} },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(extractWhatsAppMessages(body), [
    { userId: '111', text: 'hi' },
    { userId: '222', text: 'Checkout' },
  ]);
  assert.deepEqual(extractWhatsAppMessages(undefined), []);
});

test('WhatsApp: up to 3 short buttons become reply buttons, otherwise plain text', () => {
  const interactive = buildWhatsAppPayload('111', { text: 'Pick', buttons: ['Add more', 'Checkout', 'Cancel'] }) as any;
  assert.equal(interactive.type, 'interactive');
  assert.equal(interactive.interactive.action.buttons[1].reply.title, 'Checkout');

  const tooMany = buildWhatsAppPayload('111', { text: 'Pick', buttons: ['a', 'b', 'c', 'd'] }) as any;
  assert.equal(tooMany.type, 'text');
  assert.match(tooMany.text.body, /Reply with: a \/ b \/ c \/ d/);
});

test('Meta signature check', () => {
  const body = Buffer.from('{"entry":[]}');
  const good = `sha256=${createHmac('sha256', 'app_secret').update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, good, 'app_secret'), true);
  assert.equal(verifyMetaSignature(body, good, 'other'), false);
  assert.equal(verifyMetaSignature(body, 'sha1=abc', 'app_secret'), false);
  assert.equal(verifyMetaSignature(body, undefined, 'app_secret'), false);
});

test('Telegram: payload keyboards and message extraction', () => {
  assert.deepEqual(buildTelegramPayload('42', { text: 'Hi', buttons: ['Menu'] }).reply_markup, {
    keyboard: [[{ text: 'Menu' }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
  assert.deepEqual(buildTelegramPayload('42', { text: 'Hi' }).reply_markup, { remove_keyboard: true });
  assert.deepEqual(extractTelegramMessage({ update_id: 1, message: { chat: { id: 42 }, text: 'hi' } }), {
    userId: '42',
    text: 'hi',
  });
  assert.equal(extractTelegramMessage({ update_id: 2, message: { chat: { id: 42 } } }), undefined);
});

test('order file survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'order-bot-'));
  try {
    const file = join(dir, 'nested', 'orders.json');
    const first = new OrderRepository(file);
    await first.create(order);
    await first.update('ABC', { status: 'paid' });

    const second = new OrderRepository(file);
    const loaded = await second.findByReference('ORD-ABC');
    assert.equal(loaded?.status, 'paid');
    assert.equal((await second.latestForUser('whatsapp', '447700900000'))?.id, 'ABC');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
