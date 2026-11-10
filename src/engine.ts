import { randomBytes } from 'node:crypto';
import { formatMoney, type Catalog, type Product } from './catalog.js';
import type { ChannelName, Order, OrderLine, OrderStore } from './store.js';

/** One outgoing message. Channels render `buttons` as quick replies where they can. */
export interface Reply {
  text: string;
  buttons?: string[];
}

export interface PaymentProvider {
  /** Returns a URL where the customer can pay for the order. */
  createPaymentLink(order: Order): Promise<string>;
}

type State =
  | 'idle'
  | 'awaiting_item'
  | 'awaiting_qty'
  | 'awaiting_next'
  | 'awaiting_name'
  | 'awaiting_address'
  | 'awaiting_confirm';

interface Session {
  state: State;
  cart: OrderLine[];
  pendingProductId?: string;
  customerName?: string;
  address?: string;
}

export interface OrderBotDeps {
  catalog: Catalog;
  store: OrderStore;
  payments: PaymentProvider;
  newId?: () => string;
  now?: () => Date;
}

export const MAX_QTY = 50;

export const BUTTONS = {
  menu: 'Menu',
  help: 'Help',
  addMore: 'Add more',
  checkout: 'Checkout',
  cancel: 'Cancel',
  yes: 'Yes, place order',
  no: 'No, go back',
} as const;

const GREETINGS = new Set(['hi', 'hello', 'hey', 'start', '/start', 'good morning', 'good afternoon', 'good evening']);
const YES = new Set(['yes', 'y', 'yes, place order', 'confirm', 'ok', 'okay']);
const NO = new Set(['no', 'n', 'no, go back', 'back']);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

export class OrderBot {
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: OrderBotDeps) {
    this.newId = deps.newId ?? (() => randomBytes(4).toString('hex').toUpperCase());
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Handles one incoming customer message. Messages from the same customer are
   * processed one at a time, in arrival order, even if webhooks arrive together.
   */
  handle(channel: ChannelName, userId: string, text: string): Promise<Reply[]> {
    const key = `${channel}:${userId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(() => this.process(key, channel, userId, text));
    const tail = result.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }

  /**
   * Marks an order as paid. Returns the updated order only when this call
   * changed it, so callers notify the customer exactly once even if the
   * payment provider retries its webhook.
   */
  async markPaid(
    reference: string,
    check?: { amount?: number; currency?: string },
  ): Promise<Order | undefined> {
    const order = await this.deps.store.findByReference(reference);
    if (!order || order.status !== 'pending_payment') return undefined;
    if (check?.amount !== undefined && check.amount !== order.total) {
      console.warn(`[payments] ${reference}: paid ${check.amount}, expected ${order.total}. Not marking as paid.`);
      return undefined;
    }
    if (check?.currency !== undefined && check.currency.toUpperCase() !== order.currency) {
      console.warn(`[payments] ${reference}: paid in ${check.currency}, expected ${order.currency}. Not marking as paid.`);
      return undefined;
    }
    return this.deps.store.update(order.id, { status: 'paid', paidAt: this.now().toISOString() });
  }

  paymentConfirmedReply(order: Order): Reply {
    return {
      text:
        `Payment received for order ${order.reference} ✅\n` +
        `Total paid: ${this.money(order.total)}\n\n` +
        `We're preparing it now and will deliver to:\n${order.address}`,
    };
  }

  private async process(key: string, channel: ChannelName, userId: string, raw: string): Promise<Reply[]> {
    let session = this.sessions.get(key);
    if (!session) {
      session = { state: 'idle', cart: [] };
      this.sessions.set(key, session);
    }
    const text = raw.trim();
    const cmd = normalize(text);

    // Commands that work at any point in the conversation.
    if (cmd === 'cancel' || cmd === '/cancel') {
      this.reset(session);
      return [{ text: 'Order cancelled. Tap Menu whenever you are ready.', buttons: [BUTTONS.menu] }];
    }
    if (GREETINGS.has(cmd)) {
      this.reset(session);
      return [this.welcome()];
    }
    if (cmd === 'menu' || cmd === '/menu' || cmd === 'order' || cmd === 'add more') {
      session.state = 'awaiting_item';
      session.pendingProductId = undefined;
      return [this.menu()];
    }
    if (cmd === 'status' || cmd === '/status') return [await this.status(channel, userId)];
    if (cmd === 'help' || cmd === '/help') return [this.help()];

    // Questions are answered whenever we are not waiting for free text.
    const expectsFreeText = session.state === 'awaiting_name' || session.state === 'awaiting_address';
    if (!expectsFreeText && !/^\d+$/.test(cmd)) {
      const faq = this.matchFaq(cmd);
      if (faq) return [{ text: faq, buttons: this.buttonsFor(session) }];
    }

    switch (session.state) {
      case 'awaiting_item':
        return this.onItem(session, text);
      case 'awaiting_qty':
        return this.onQty(session, text);
      case 'awaiting_next':
        return this.onNext(session, cmd);
      case 'awaiting_name':
        return this.onName(session, text);
      case 'awaiting_address':
        return this.onAddress(session, text);
      case 'awaiting_confirm':
        return this.onConfirm(session, cmd, channel, userId);
      case 'idle':
        return [{ text: "Sorry, I didn't catch that.", buttons: [BUTTONS.menu, BUTTONS.help] }];
    }
  }

  private onItem(session: Session, text: string): Reply[] {
    const product = this.pickProduct(text);
    if (!product) {
      return [{ text: `Please reply with a number from 1 to ${this.deps.catalog.products.length}.` }];
    }
    session.pendingProductId = product.id;
    session.state = 'awaiting_qty';
    return [{ text: `How many "${product.name}"? (1-${MAX_QTY})`, buttons: ['1', '2', '3'] }];
  }

  private onQty(session: Session, text: string): Reply[] {
    const product = this.deps.catalog.products.find((p) => p.id === session.pendingProductId);
    if (!product) {
      session.state = 'awaiting_item';
      return [this.menu()];
    }
    const qty = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
    if (!(qty >= 1 && qty <= MAX_QTY)) {
      return [{ text: `Please send a number from 1 to ${MAX_QTY}.`, buttons: ['1', '2', '3'] }];
    }
    const existing = session.cart.find((l) => l.productId === product.id);
    if (existing) {
      existing.qty = Math.min(MAX_QTY, existing.qty + qty);
    } else {
      session.cart.push({ productId: product.id, name: product.name, unitAmount: product.unitAmount, qty });
    }
    session.pendingProductId = undefined;
    session.state = 'awaiting_next';
    return [
      {
        text: `Added ${qty} × ${product.name}.\n\n${this.cartLines(session.cart)}\nSubtotal: ${this.money(this.subtotal(session.cart))}`,
        buttons: [BUTTONS.addMore, BUTTONS.checkout, BUTTONS.cancel],
      },
    ];
  }

  private onNext(session: Session, cmd: string): Reply[] {
    if (cmd === 'checkout' || cmd === '2') {
      if (session.cart.length === 0) {
        session.state = 'awaiting_item';
        return [{ text: 'Your basket is empty.' }, this.menu()];
      }
      session.state = 'awaiting_name';
      return [{ text: 'Great! What name should we put on the order?' }];
    }
    if (cmd === '1') {
      session.state = 'awaiting_item';
      return [this.menu()];
    }
    if (cmd === '3') {
      this.reset(session);
      return [{ text: 'Order cancelled. Tap Menu whenever you are ready.', buttons: [BUTTONS.menu] }];
    }
    return [{ text: 'Tap Add more, Checkout or Cancel.', buttons: [BUTTONS.addMore, BUTTONS.checkout, BUTTONS.cancel] }];
  }

  private onName(session: Session, text: string): Reply[] {
    if (text.length < 2 || text.length > 60) {
      return [{ text: 'Please send a name between 2 and 60 characters.' }];
    }
    session.customerName = text;
    session.state = 'awaiting_address';
    return [{ text: `Thanks, ${text}. What's the delivery address, including postcode?` }];
  }

  private onAddress(session: Session, text: string): Reply[] {
    if (text.length < 5 || text.length > 200) {
      return [{ text: 'Please send the full delivery address (street, town, postcode).' }];
    }
    session.address = text;
    session.state = 'awaiting_confirm';
    return [this.confirmPrompt(session)];
  }

  private async onConfirm(session: Session, cmd: string, channel: ChannelName, userId: string): Promise<Reply[]> {
    if (NO.has(cmd)) {
      session.state = 'awaiting_next';
      return [{ text: 'No problem, your basket is saved.', buttons: [BUTTONS.addMore, BUTTONS.checkout, BUTTONS.cancel] }];
    }
    if (!YES.has(cmd)) return [this.confirmPrompt(session)];
    return this.placeOrder(session, channel, userId);
  }

  private async placeOrder(session: Session, channel: ChannelName, userId: string): Promise<Reply[]> {
    const { catalog, payments, store } = this.deps;
    const id = this.newId();
    const subtotal = this.subtotal(session.cart);
    const order: Order = {
      id,
      reference: `ORD-${id}`,
      channel,
      userId,
      customerName: session.customerName ?? '',
      address: session.address ?? '',
      currency: catalog.currency,
      lines: session.cart.map((l) => ({ ...l })),
      deliveryFee: catalog.deliveryFee,
      total: subtotal + catalog.deliveryFee,
      status: 'pending_payment',
      createdAt: this.now().toISOString(),
    };

    let url: string;
    try {
      url = await payments.createPaymentLink(order);
    } catch (err) {
      console.error(`[payments] could not create a link for ${order.reference}:`, err);
      return [
        {
          text: "Sorry, we couldn't create your payment link just now. Tap Yes to try again.",
          buttons: [BUTTONS.yes, BUTTONS.no],
        },
      ];
    }

    order.paymentUrl = url;
    await store.create(order);
    this.reset(session);
    return [
      {
        text:
          `Order ${order.reference} placed! 🎉\n` +
          `Total: ${this.money(order.total)}\n\n` +
          `Pay securely here:\n${url}\n\n` +
          `We'll message you as soon as payment is confirmed. Type STATUS any time to check.`,
      },
    ];
  }

  private async status(channel: ChannelName, userId: string): Promise<Reply> {
    const order = await this.deps.store.latestForUser(channel, userId);
    if (!order) return { text: "You don't have any orders yet.", buttons: [BUTTONS.menu] };
    const state = order.status === 'paid' ? 'paid ✅, being prepared' : 'waiting for payment';
    const payLine = order.status === 'pending_payment' && order.paymentUrl ? `\nPay here: ${order.paymentUrl}` : '';
    return { text: `Order ${order.reference} (${this.money(order.total)}) is ${state}.${payLine}` };
  }

  private welcome(): Reply {
    return {
      text:
        `Welcome to ${this.deps.catalog.businessName}! 👋\n` +
        `I can take your order and send you a secure payment link, ` +
        `or answer questions about opening hours, delivery and payment.`,
      buttons: [BUTTONS.menu, BUTTONS.help],
    };
  }

  private help(): Reply {
    return {
      text:
        'You can type:\n' +
        '• MENU to start an order\n' +
        '• STATUS to check your last order\n' +
        '• CANCEL to start over\n\n' +
        'Or just ask, for example "when are you open?" or "do you deliver?"',
      buttons: [BUTTONS.menu],
    };
  }

  private menu(): Reply {
    const lines = this.deps.catalog.products.map(
      (p, i) => `${i + 1}. ${p.name}: ${this.money(p.unitAmount)}`,
    );
    return {
      text: `${this.deps.catalog.businessName} menu\n\n${lines.join('\n')}\n\nReply with the number of the item you want.`,
    };
  }

  private confirmPrompt(session: Session): Reply {
    const subtotal = this.subtotal(session.cart);
    const delivery = this.deps.catalog.deliveryFee;
    return {
      text:
        `Please confirm your order:\n\n${this.cartLines(session.cart)}\n` +
        `Delivery: ${this.money(delivery)}\n` +
        `Total: ${this.money(subtotal + delivery)}\n\n` +
        `Name: ${session.customerName}\nAddress: ${session.address}`,
      buttons: [BUTTONS.yes, BUTTONS.no],
    };
  }

  private buttonsFor(session: Session): string[] {
    if (session.state === 'awaiting_next') return [BUTTONS.addMore, BUTTONS.checkout, BUTTONS.cancel];
    if (session.state === 'awaiting_confirm') return [BUTTONS.yes, BUTTONS.no];
    return [BUTTONS.menu];
  }

  private pickProduct(text: string): Product | undefined {
    const { products } = this.deps.catalog;
    if (/^\d+$/.test(text)) return products[Number(text) - 1];
    const wanted = normalize(text);
    if (wanted.length < 3) return undefined;
    return products.find((p) => p.name.toLowerCase().startsWith(wanted));
  }

  private matchFaq(cmd: string): string | undefined {
    const words = new Set(cmd.split(/[^\p{L}\p{N}]+/u));
    return this.deps.catalog.faq.find((f) =>
      f.keywords.some((k) => (k.includes(' ') ? cmd.includes(k) : words.has(k))),
    )?.answer;
  }

  private cartLines(cart: OrderLine[]): string {
    return cart.map((l) => `${l.qty} × ${l.name}: ${this.money(l.unitAmount * l.qty)}`).join('\n');
  }

  private subtotal(cart: OrderLine[]): number {
    return cart.reduce((sum, l) => sum + l.unitAmount * l.qty, 0);
  }

  private money(minor: number): string {
    return formatMoney(minor, this.deps.catalog.currency);
  }

  private reset(session: Session): void {
    session.state = 'idle';
    session.cart = [];
    session.pendingProductId = undefined;
    session.customerName = undefined;
    session.address = undefined;
  }
}
