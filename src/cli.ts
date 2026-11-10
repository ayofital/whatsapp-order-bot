/**
 * Chat with the bot in your terminal: no accounts, tokens or server needed.
 * Handy for recording a demo video. Orders live in memory and vanish on exit.
 */
import { join } from 'node:path';
import readline from 'node:readline';
import { loadCatalog } from './catalog.js';
import { OrderBot, type Reply } from './engine.js';
import { MockPaymentProvider } from './payments.js';
import { OrderRepository } from './store.js';

const USER = 'terminal-customer';

const catalog = loadCatalog(join(process.env.DATA_DIR ?? 'data', 'catalog.json'));
const store = new OrderRepository();
const bot = new OrderBot({ catalog, store, payments: new MockPaymentProvider('https://pay.example.com') });

function print(replies: Reply[]): void {
  for (const reply of replies) {
    console.log(`\nbot › ${reply.text.replace(/\n/g, '\n      ')}`);
    if (reply.buttons?.length) console.log(`      ${reply.buttons.map((b) => `[${b}]`).join(' ')}`);
  }
  console.log('');
}

console.log(`\n${catalog.businessName} ordering bot, terminal demo`);
console.log('Type as if you were a customer (try "hi"). Extra commands: /paid fakes a payment, /quit exits.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you › ' });
rl.prompt();

for await (const line of rl) {
  const text = line.trim();
  if (text === '/quit' || text === '/exit') break;
  if (text === '') {
    rl.prompt();
    continue;
  }
  if (text === '/paid') {
    const latest = await store.latestForUser('cli', USER);
    const paid = latest && (await bot.markPaid(latest.reference));
    print(paid ? [bot.paymentConfirmedReply(paid)] : [{ text: '(no unpaid order to pay for)' }]);
  } else {
    print(await bot.handle('cli', USER, text));
  }
  rl.prompt();
}
rl.close();
