import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentProvider } from './engine.js';
import type { Order } from './store.js';

export interface StripeOptions {
  successUrl: string;
  cancelUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Creates Stripe Checkout Sessions with plain HTTPS calls (no SDK needed).
 * The order reference goes in client_reference_id so the webhook can find it.
 */
export class StripeProvider implements PaymentProvider {
  constructor(
    private readonly secretKey: string,
    private readonly opts: StripeOptions,
  ) {}

  async createPaymentLink(order: Order): Promise<string> {
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', this.opts.successUrl);
    form.set('cancel_url', this.opts.cancelUrl);
    form.set('client_reference_id', order.reference);
    form.set('metadata[order_reference]', order.reference);
    form.set('payment_intent_data[metadata][order_reference]', order.reference);

    const currency = order.currency.toLowerCase();
    const items = order.lines.map((l) => ({ name: l.name, unitAmount: l.unitAmount, qty: l.qty }));
    if (order.deliveryFee > 0) items.push({ name: 'Delivery', unitAmount: order.deliveryFee, qty: 1 });
    items.forEach((item, i) => {
      form.set(`line_items[${i}][quantity]`, String(item.qty));
      form.set(`line_items[${i}][price_data][currency]`, currency);
      form.set(`line_items[${i}][price_data][unit_amount]`, String(item.unitAmount));
      form.set(`line_items[${i}][price_data][product_data][name]`, item.name);
    });

    const res = await (this.opts.fetchImpl ?? fetch)('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Retrying with the same key never creates a second session for this order.
        'Idempotency-Key': `checkout-${order.reference}`,
      },
      body: form.toString(),
    });
    const body = (await res.json().catch(() => undefined)) as
      | { url?: string; error?: { message?: string } }
      | undefined;
    if (!res.ok || !body?.url) {
      throw new Error(`Stripe checkout failed (${res.status}): ${body?.error?.message ?? 'no message'}`);
    }
    return body.url;
  }
}

/**
 * Verifies the Stripe-Signature header (format "t=<unix>,v1=<hex>[,v1=...]").
 * Rejects events older than `toleranceSeconds` to stop replayed webhooks.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  webhookSecret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;

  const expected = Buffer.from(
    createHmac('sha256', webhookSecret).update(`${timestamp}.`).update(rawBody).digest('hex'),
    'utf8',
  );
  return signatures.some((sig) => {
    const candidate = Buffer.from(sig, 'utf8');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

/** Used when no Stripe key is set: links point at this server, which fakes a payment. */
export class MockPaymentProvider implements PaymentProvider {
  constructor(private readonly baseUrl: string) {}

  async createPaymentLink(order: Order): Promise<string> {
    return `${this.baseUrl.replace(/\/$/, '')}/mock-pay/${encodeURIComponent(order.reference)}`;
  }
}
