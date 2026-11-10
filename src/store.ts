import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ChannelName = 'telegram' | 'whatsapp' | 'cli';
export type OrderStatus = 'pending_payment' | 'paid';

export interface OrderLine {
  productId: string;
  name: string;
  unitAmount: number;
  qty: number;
}

export interface Order {
  id: string;
  /** Sent to the payment provider and used to match its webhook back to this order. */
  reference: string;
  channel: ChannelName;
  userId: string;
  customerName: string;
  address: string;
  currency: string;
  lines: OrderLine[];
  deliveryFee: number;
  total: number;
  status: OrderStatus;
  paymentUrl?: string;
  createdAt: string;
  paidAt?: string;
}

export interface OrderStore {
  create(order: Order): Promise<void>;
  update(id: string, patch: Partial<Order>): Promise<Order | undefined>;
  findByReference(reference: string): Promise<Order | undefined>;
  latestForUser(channel: ChannelName, userId: string): Promise<Order | undefined>;
  list(): Promise<Order[]>;
}

const clone = (o: Order): Order => structuredClone(o);

/**
 * Keeps orders in memory and, when given a file path, mirrors them to a JSON
 * file. Writes are serialised and done via a temp file + rename so a crash
 * mid-write never leaves a half-written file. Swap this class for a Postgres
 * implementation of OrderStore when a client needs more than one server.
 */
export class OrderRepository implements OrderStore {
  private loading?: Promise<Order[]>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath?: string) {}

  private load(): Promise<Order[]> {
    this.loading ??= (async () => {
      if (!this.filePath) return [];
      try {
        return JSON.parse(await readFile(this.filePath, 'utf8')) as Order[];
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    })();
    return this.loading;
  }

  private async persist(orders: Order[]): Promise<void> {
    const file = this.filePath;
    if (!file) return;
    const snapshot = JSON.stringify(orders, null, 2);
    const run = this.writeQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, file);
    });
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  async create(order: Order): Promise<void> {
    const orders = await this.load();
    orders.push(clone(order));
    await this.persist(orders);
  }

  async update(id: string, patch: Partial<Order>): Promise<Order | undefined> {
    const orders = await this.load();
    const order = orders.find((o) => o.id === id);
    if (!order) return undefined;
    Object.assign(order, patch, { id: order.id });
    await this.persist(orders);
    return clone(order);
  }

  async findByReference(reference: string): Promise<Order | undefined> {
    const order = (await this.load()).find((o) => o.reference === reference);
    return order && clone(order);
  }

  async latestForUser(channel: ChannelName, userId: string): Promise<Order | undefined> {
    const orders = await this.load();
    for (let i = orders.length - 1; i >= 0; i--) {
      const o = orders[i]!;
      if (o.channel === channel && o.userId === userId) return clone(o);
    }
    return undefined;
  }

  async list(): Promise<Order[]> {
    return (await this.load()).map(clone);
  }
}
