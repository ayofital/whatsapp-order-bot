import type { Reply } from '../engine.js';

/** Anything that can deliver bot replies to a customer on a given channel. */
export interface Sender {
  send(userId: string, replies: Reply[]): Promise<void>;
}
