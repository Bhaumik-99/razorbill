import { id, nowISO } from './util.js';
import { byId, PRODUCTS } from './catalog.js';

/**
 * In-memory state. Deliberately not a database: the point of this project is the money
 * rail, and a Map keeps the whole state machine readable in one file. Everything that
 * matters for audit is in the hash-chained ledger, which does persist.
 */
class Store {
  constructor() {
    this.sessions = new Map();
    this.orders = new Map();
    this.approvals = new Map();
    this.reservations = new Map();   // reservation_id -> {order_id, lines:[{product_id, qty}]}
    this.consumedNonces = new Set();
    this.spend = new Map();          // actor_id -> {date, total_minor}
    this.actionTimes = new Map();    // actor_id -> [epoch ms]
    this.idempotency = new Map();    // key -> stored result envelope
    this.stockBaseline = new Map(PRODUCTS.map((p) => [p.id, p.stock]));
  }

  // -- sessions ----------------------------------------------------------

  createSession({ actor = { type: 'human', id: 'shopper' }, mandate_token = null, channel = 'chat' } = {}) {
    const s = {
      id: id('ses'),
      actor,
      channel,
      mandate_token,
      cart: { items: [], discount_minor: 0, discount_reason: null },
      created_at: nowISO(),
      last_activity: Date.now(),
      state: 'browsing',
      offers_shown: [],
      offers_accepted: [],
      transcript: [],
    };
    this.sessions.set(s.id, s);
    return s;
  }

  session(sid) {
    const s = this.sessions.get(sid);
    if (s) s.last_activity = Date.now();
    return s || null;
  }

  // -- cart --------------------------------------------------------------

  addToCart(sid, product_id, qty = 1) {
    const s = this.session(sid);
    if (!s) throw new Error('unknown session');
    const p = byId(product_id);
    if (!p) throw new Error(`unknown product ${product_id}`);
    const line = s.cart.items.find((i) => i.product_id === product_id);
    const maxQty = p.category === 'subscription' ? 1 : 10;
    if (line) line.qty = Math.min(maxQty, line.qty + qty);
    else s.cart.items.push({ product_id, qty: Math.min(maxQty, qty), unit_price: p.price, title: p.title, category: p.category });
    return this.priceCart(sid);
  }

  removeFromCart(sid, product_id) {
    const s = this.session(sid);
    if (!s) throw new Error('unknown session');
    s.cart.items = s.cart.items.filter((i) => i.product_id !== product_id);
    return this.priceCart(sid);
  }

  setDiscount(sid, minor, reason) {
    const s = this.session(sid);
    s.cart.discount_minor = Math.max(0, Math.round(minor));
    s.cart.discount_reason = reason;
    return this.priceCart(sid);
  }

  /** Single source of truth for money. Integer paise throughout; no floats anywhere. */
  priceCart(sid) {
    const s = this.session(sid);
    if (!s) throw new Error('unknown session');
    const items = s.cart.items.map((i) => {
      const p = byId(i.product_id);
      return { ...i, unit_price: p.price, line_total: p.price * i.qty, glyph: p.glyph };
    });
    const subtotal = items.reduce((sum, i) => sum + i.line_total, 0);
    const discount = Math.min(s.cart.discount_minor || 0, subtotal);
    const afterDiscount = subtotal - discount;
    const FREE_SHIP = 150000;
    const shipping = afterDiscount === 0 ? 0 : afterDiscount >= FREE_SHIP ? 0 : 9900;
    const total = afterDiscount + shipping;
    return {
      session_id: sid,
      items,
      unit_count: items.reduce((n, i) => n + i.qty, 0),
      subtotal,
      discount_minor: discount,
      discount_reason: s.cart.discount_reason,
      shipping_minor: shipping,
      free_shipping_threshold: FREE_SHIP,
      amount_to_free_shipping: Math.max(0, FREE_SHIP - afterDiscount),
      total,
      currency: 'INR',
    };
  }

  // -- inventory ---------------------------------------------------------

  /** Reserve stock before charging, so two agents cannot sell the same last unit. */
  reserve(order_id, lines) {
    for (const l of lines) {
      const p = byId(l.product_id);
      if (!p || p.stock < l.qty) return { ok: false, product_id: l.product_id, available: p ? p.stock : 0 };
    }
    for (const l of lines) byId(l.product_id).stock -= l.qty;
    const rid = id('rsv');
    this.reservations.set(rid, { order_id, lines, created_at: nowISO(), state: 'held' });
    return { ok: true, reservation_id: rid };
  }

  /** Compensating transaction. Called whenever a charge fails after stock was held. */
  release(reservation_id) {
    const r = this.reservations.get(reservation_id);
    if (!r || r.state !== 'held') return { ok: false, reason: 'not_held' };
    for (const l of r.lines) byId(l.product_id).stock += l.qty;
    r.state = 'released';
    r.released_at = nowISO();
    return { ok: true, restored: r.lines };
  }

  commit(reservation_id) {
    const r = this.reservations.get(reservation_id);
    if (!r) return { ok: false };
    r.state = 'committed';
    return { ok: true };
  }

  // -- policy counters ---------------------------------------------------

  counters(actor_id) {
    const today = new Date().toISOString().slice(0, 10);
    const rec = this.spend.get(actor_id);
    const spent = rec && rec.date === today ? rec.total_minor : 0;
    return {
      agent_spend_today: spent,
      recent_actions: this.actionTimes.get(actor_id) || [],
      consumed_nonces: this.consumedNonces,
    };
  }

  recordSpend(actor_id, minor) {
    const today = new Date().toISOString().slice(0, 10);
    const rec = this.spend.get(actor_id);
    if (rec && rec.date === today) rec.total_minor += minor;
    else this.spend.set(actor_id, { date: today, total_minor: minor });
  }

  recordAction(actor_id) {
    const arr = this.actionTimes.get(actor_id) || [];
    arr.push(Date.now());
    this.actionTimes.set(actor_id, arr.slice(-50));
  }

  consumeNonce(nonce) {
    this.consumedNonces.add(nonce);
  }

  // -- idempotency -------------------------------------------------------

  rememberResult(key, envelope) {
    if (key) this.idempotency.set(key, { at: nowISO(), envelope });
  }

  recallResult(key) {
    const hit = key ? this.idempotency.get(key) : null;
    return hit ? hit.envelope : null;
  }

  // -- orders & approvals ------------------------------------------------

  createOrder(o) {
    this.orders.set(o.id, o);
    return o;
  }

  order(oid) {
    return this.orders.get(oid) || null;
  }

  createApproval(a) {
    this.approvals.set(a.id, a);
    return a;
  }

  pendingApprovals() {
    return [...this.approvals.values()].filter((a) => a.state === 'pending');
  }

  /** Carts idle past `ms` with items in them: the trigger for recovery campaigns. */
  staleCarts(ms = 45_000) {
    const out = [];
    for (const s of this.sessions.values()) {
      if (s.state === 'paid' || s.state === 'abandoned_recovered') continue;
      if (!s.cart.items.length) continue;
      if (Date.now() - s.last_activity >= ms) out.push(s);
    }
    return out;
  }

  metrics() {
    const orders = [...this.orders.values()];
    const paid = orders.filter((o) => o.state === 'paid');
    const revenue = paid.reduce((s, o) => s + o.total, 0);
    const attach = paid.filter((o) => o.upsell_attached).length;
    return {
      sessions: this.sessions.size,
      orders_created: orders.length,
      orders_paid: paid.length,
      orders_failed: orders.filter((o) => o.state === 'payment_failed').length,
      revenue_minor: revenue,
      aov_minor: paid.length ? Math.round(revenue / paid.length) : 0,
      attach_rate: paid.length ? +(attach / paid.length).toFixed(3) : 0,
      agent_attributed_minor: paid.reduce((s, o) => s + (o.agent_attributed_minor || 0), 0),
      pending_approvals: this.pendingApprovals().length,
    };
  }
}

export const store = new Store();
