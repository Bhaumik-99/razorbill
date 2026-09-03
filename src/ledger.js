import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256, nowISO } from './util.js';

const FILE = path.join(process.cwd(), 'data', 'ledger.json');
const GENESIS = '0'.repeat(64);

/**
 * Append-only, hash-chained audit log.
 *
 * Each entry commits to the hash of the entry before it, so editing or deleting any
 * historical row invalidates every hash after it. `verify()` recomputes the whole
 * chain and reports the first break. This is the merchant's evidence that an agent
 * did exactly what the log says it did, and nothing else.
 *
 * Every money action writes here. Nothing charges without a row.
 */
class Ledger {
  constructor() {
    this.entries = [];
    this.subscribers = new Set();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(FILE, 'utf8');
      this.entries = JSON.parse(raw);
    } catch {
      this.entries = [];
    }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.entries, null, 2));
    } catch (e) {
      // A ledger that cannot persist must be loud, not silent.
      console.error('[ledger] persist failed:', e.message);
    }
  }

  get head() {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
  }

  /**
   * The bytes that get hashed: every field of the entry except the hash itself.
   *
   * This must cover the whole record, not a chosen subset. An earlier version hashed
   * only seq/ts/prev_hash/actor/action/payload, which left `amount_minor`, `decision`
   * and `order_id` outside the commitment -- someone with write access could have
   * rewritten a captured amount and the chain would still have verified. Canonical JSON
   * gives a stable key order, so the digest is reproducible across processes.
   */
  static digest(e) {
    const { hash, ...committed } = e;
    return sha256(canonical(committed));
  }

  /**
   * @param action   dotted event name, e.g. 'payment.failed'
   * @param opts.actor      who caused it: {type:'agent'|'human'|'system', id}
   * @param opts.payload    the facts
   * @param opts.decision   policy decision attached to a money action, if any
   * @param opts.amount     integer paise, if this moved or would have moved money
   */
  append(action, opts = {}) {
    const { actor = { type: 'system', id: 'razorbill' }, payload = {}, decision = null, amount = null,
      session_id = null, order_id = null, severity = 'info' } = opts;
    const entry = {
      seq: this.entries.length + 1,
      ts: nowISO(),
      prev_hash: this.head,
      actor_type: actor.type,
      actor_id: actor.id,
      action,
      severity,
      amount_minor: amount,
      currency: amount == null ? null : 'INR',
      session_id,
      order_id,
      decision,
      payload,
      hash: null,
    };
    entry.hash = Ledger.digest(entry);
    this.entries.push(entry);
    this.persist();
    for (const fn of this.subscribers) {
      try { fn(entry); } catch { /* a bad subscriber must not break the write */ }
    }
    return entry;
  }

  /** Recompute the chain. Returns the first inconsistency found, if any. */
  verify() {
    let prev = GENESIS;
    for (const e of this.entries) {
      if (e.prev_hash !== prev) {
        return { ok: false, broken_at: e.seq, reason: 'prev_hash mismatch (an earlier entry was altered or removed)' };
      }
      if (Ledger.digest(e) !== e.hash) {
        return { ok: false, broken_at: e.seq, reason: 'content hash mismatch (this entry was altered after it was written)' };
      }
      prev = e.hash;
    }
    return { ok: true, entries: this.entries.length, head: this.head };
  }

  query({ session_id, order_id, action, actor_type, since_seq = 0, limit = 200 } = {}) {
    return this.entries
      .filter((e) => e.seq > since_seq)
      .filter((e) => !session_id || e.session_id === session_id)
      .filter((e) => !order_id || e.order_id === order_id)
      .filter((e) => !action || e.action.startsWith(action))
      .filter((e) => !actor_type || e.actor_type === actor_type)
      .slice(-limit);
  }

  /** Every money-affecting row for one order, in sequence: the "show me the trail" view. */
  trail(order_id) {
    return this.query({ order_id }).map((e) => ({
      seq: e.seq,
      ts: e.ts,
      action: e.action,
      actor: `${e.actor_type}:${e.actor_id}`,
      amount_minor: e.amount_minor,
      verdict: e.decision ? e.decision.verdict : null,
      because: e.decision ? e.decision.summary : (e.payload.reason || e.payload.note || null),
      hash: e.hash.slice(0, 12),
    }));
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  reset() {
    this.entries = [];
    this.persist();
  }
}

export const ledger = new Ledger();
