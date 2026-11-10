import { readFileSync } from 'node:fs';

export interface Product {
  id: string;
  name: string;
  /** Price in the currency's minor unit (pence, cents). */
  unitAmount: number;
}

export interface FaqEntry {
  keywords: string[];
  answer: string;
}

export interface Catalog {
  businessName: string;
  /** ISO 4217 code, e.g. GBP, USD, EUR. */
  currency: string;
  /** Delivery fee in the currency's minor unit. */
  deliveryFee: number;
  products: Product[];
  faq: FaqEntry[];
}

interface RawCatalog {
  businessName?: unknown;
  currency?: unknown;
  deliveryFee?: unknown;
  products?: unknown;
  faq?: unknown;
}

/** Converts a major-unit price such as 5.5 into minor units (550). */
function toMinor(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`catalog: ${field} must be a non-negative number`);
  }
  return Math.round(value * 100);
}

/**
 * Loads the catalog JSON. Prices in the file are written the way a shop owner
 * writes them (5.50) and converted to minor units so all maths is integer.
 */
export function parseCatalog(json: string): Catalog {
  const raw = JSON.parse(json) as RawCatalog;

  if (typeof raw.businessName !== 'string' || raw.businessName.trim() === '') {
    throw new Error('catalog: businessName is required');
  }
  if (typeof raw.currency !== 'string' || !/^[A-Za-z]{3}$/.test(raw.currency)) {
    throw new Error('catalog: currency must be a 3-letter ISO code such as GBP or USD');
  }
  if (!Array.isArray(raw.products) || raw.products.length === 0) {
    throw new Error('catalog: products must be a non-empty list');
  }

  const seen = new Set<string>();
  const products = raw.products.map((p: { id?: unknown; name?: unknown; price?: unknown }, i: number) => {
    if (typeof p.id !== 'string' || typeof p.name !== 'string') {
      throw new Error(`catalog: products[${i}] needs an id and a name`);
    }
    if (seen.has(p.id)) throw new Error(`catalog: duplicate product id "${p.id}"`);
    seen.add(p.id);
    const unitAmount = toMinor(p.price, `products[${i}].price`);
    if (unitAmount === 0) throw new Error(`catalog: products[${i}].price must be above zero`);
    return { id: p.id, name: p.name, unitAmount };
  });

  const faq = Array.isArray(raw.faq)
    ? raw.faq.map((f: { keywords?: unknown; answer?: unknown }, i: number) => {
        if (!Array.isArray(f.keywords) || typeof f.answer !== 'string') {
          throw new Error(`catalog: faq[${i}] needs keywords and an answer`);
        }
        return { keywords: f.keywords.map((k) => String(k).toLowerCase()), answer: f.answer };
      })
    : [];

  return {
    businessName: raw.businessName,
    currency: raw.currency.toUpperCase(),
    deliveryFee: raw.deliveryFee === undefined ? 0 : toMinor(raw.deliveryFee, 'deliveryFee'),
    products,
    faq,
  };
}

export function loadCatalog(path: string): Catalog {
  return parseCatalog(readFileSync(path, 'utf8'));
}

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);
}
