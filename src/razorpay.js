import crypto from 'node:crypto';
import { id } from './util.js';

const API = 'https://api.razorpay.com/v1';

/**
 * Test instruments the agent can be handed. These exist so failure is a first-class,
 * reproducible path in the demo rather than something you hope happens.
 */
export const INSTRUMENTS = {
  card_success: { method: 'card', outcome: 'captured', label: 'Visa .. 1111 (test, succeeds)' },
  card_insufficient_funds: {
    method: 'card', outcome: 'failed', label: 'Visa .. 0002 (test, declines)',
    error: { code: 'BAD_REQUEST_ERROR', description: 'Your payment was declined by the issuing bank.',
      source: 'bank', step: 'payment_authorization', reason: 'payment_failed_insufficient_funds' },
    retryable: false, advice: 'The bank refused the charge. A different instrument is the only way forward.',
  },
  card_network_error: {
    method: 'card', outcome: 'failed', label: 'Visa .. 0009 (test, gateway timeout)',
    error: { code: 'GATEWAY_ERROR', description: 'The payment gateway did not respond in time.',
      source: 'gateway', step: 'payment_authorization', reason: 'gateway_timeout' },
    retryable: true, advice: 'Transient gateway fault. The same idempotency key can be retried safely.',
  },
  upi_success: { method: 'upi', outcome: 'captured', label: 'success@razorpay (test VPA, succeeds)' },
  upi_collect_expired: {
    method: 'upi', outcome: 'failed', label: 'failure@razorpay (test VPA, collect expires)',
    error: { code: 'BAD_REQUEST_ERROR', description: 'The UPI collect request expired before approval.',
      source: 'customer', step: 'payment_authentication', reason: 'payment_collect_expired' },
    retryable: true, advice: 'The customer never approved the collect request. Re-send or switch to card.',
  },
};

/** Razorpay returns errors in a fixed envelope; the simulator reproduces it exactly. */
export class RazorpayError extends Error {
  constructor(env, httpStatus = 400) {
    super(env.description || 'Razorpay request failed');
    this.name = 'RazorpayError';
    this.envelope = env;
    this.httpStatus = httpStatus;
    this.reason = env.reason || null;
    this.retryable = env.retryable === true;
  }
}

export class RazorpayClient {
  constructor(keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET) {
    this.keyId = keyId;
    this.keySecret = keySecret;
    // TEST hits Razorpay's real test-mode API (free, no real money).
    // SIM runs the local simulator so the project is runnable with zero setup.
    this.mode = keyId && keySecret ? 'TEST' : 'SIM';
    this._orders = new Map();
    this._payments = new Map();
  }

  get modeLabel() {
    return this.mode === 'TEST' ? 'Razorpay TEST mode (live API, no real money)' : 'Local simulator (no network)';
  }

  async _call(method, pathname, body) {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    const res = await fetch(API + pathname, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new RazorpayError(json.error || { code: 'API_ERROR', description: `HTTP ${res.status}` }, res.status);
    return json;
  }

  // -- Orders -------------------------------------------------------------

  async createOrder({ amount, receipt, notes = {} }) {
    if (this.mode === 'TEST') {
      return this._call('POST', '/orders', { amount, currency: 'INR', receipt, notes, payment_capture: 1 });
    }
    const order = {
      id: 'order_' + crypto.randomBytes(7).toString('hex'),
      entity: 'order', amount, amount_paid: 0, amount_due: amount, currency: 'INR',
      receipt, status: 'created', attempts: 0, notes, created_at: Math.floor(Date.now() / 1000),
    };
    this._orders.set(order.id, order);
    return order;
  }

  /**
   * A real payment link. In TEST mode this returns a genuine Razorpay short_url that
   * opens the hosted test checkout -- which is what makes the merchant actually
   * transactable rather than merely simulated.
   */
  async createPaymentLink({ amount, description, customer = {}, reference_id, callback_url }) {
    if (this.mode === 'TEST') {
      return this._call('POST', '/payment_links', {
        amount, currency: 'INR', description, reference_id,
        customer: { name: customer.name || 'Agent Buyer', email: customer.email || undefined, contact: customer.contact || undefined },
        notify: { sms: false, email: false },
        reminder_enable: false,
        callback_url, callback_method: callback_url ? 'get' : undefined,
      });
    }
    const plink = {
      id: 'plink_' + crypto.randomBytes(7).toString('hex'),
      entity: 'payment_link', amount, currency: 'INR', description, reference_id,
      status: 'created', short_url: null, created_at: Math.floor(Date.now() / 1000),
    };
    plink.short_url = `http://localhost:${process.env.PORT || 3000}/sim/checkout/${plink.id}`;
    this._orders.set(plink.id, plink);
    return plink;
  }

  /**
   * Authorize + capture against a chosen test instrument.
   *
   * TEST mode note: card authorisation legitimately cannot happen server-side -- it needs
   * the hosted checkout. So in TEST mode the merchant-side artefacts (order, payment link)
   * are real API objects and authorisation is driven through the simulator, which mirrors
   * Razorpay's response and error shapes exactly. The distinction is recorded in the ledger
   * on every entry rather than glossed over.
   */
  async authorizeAndCapture({ order_id, amount, instrument = 'card_success', idempotency_key }) {
    const spec = INSTRUMENTS[instrument];
    if (!spec) {
      throw new RazorpayError({ code: 'BAD_REQUEST_ERROR', description: `Unknown test instrument "${instrument}".`,
        source: 'business', step: 'payment_initiation', reason: 'invalid_instrument' });
    }

    // Idempotency is enforced here, at the edge closest to the money: a replayed key
    // returns the original outcome -- success or failure -- and never charges twice.
    if (idempotency_key && this._payments.has(idempotency_key)) {
      const prior = this._payments.get(idempotency_key);
      if (prior.ok) return { ...prior.value, _replayed: true };
      const err = new RazorpayError(prior.error.envelope, 400);
      err.replayed = true;
      throw err;
    }

    const payment = {
      id: 'pay_' + crypto.randomBytes(7).toString('hex'),
      entity: 'payment', amount, currency: 'INR', order_id,
      method: spec.method, captured: false, status: 'created',
      created_at: Math.floor(Date.now() / 1000),
      notes: { instrument, simulated: true },
    };

    if (spec.outcome === 'failed') {
      payment.status = 'failed';
      payment.error_code = spec.error.code;
      payment.error_reason = spec.error.reason;
      const envelope = { ...spec.error, retryable: spec.retryable, advice: spec.advice,
        metadata: { payment_id: payment.id, order_id } };
      const err = new RazorpayError(envelope, 400);
      if (idempotency_key) this._payments.set(idempotency_key, { ok: false, error: err });
      this._payments.set(payment.id, { ok: false, error: err });
      throw err;
    }

    payment.status = 'captured';
    payment.captured = true;
    const order = this._orders.get(order_id);
    if (order) { order.status = 'paid'; order.amount_paid = amount; order.amount_due = 0; }
    const value = { payment, order_id, mode: this.mode };
    if (idempotency_key) this._payments.set(idempotency_key, { ok: true, value });
    return value;
  }

  async refund({ payment_id, amount, idempotency_key }) {
    if (idempotency_key && this._payments.has('rf:' + idempotency_key)) {
      return { ...this._payments.get('rf:' + idempotency_key).value, _replayed: true };
    }
    if (this.mode === 'TEST') {
      const r = await this._call('POST', `/payments/${payment_id}/refund`, { amount });
      return { refund: r };
    }
    const refund = {
      id: 'rfnd_' + crypto.randomBytes(7).toString('hex'),
      entity: 'refund', amount, currency: 'INR', payment_id, status: 'processed',
      created_at: Math.floor(Date.now() / 1000),
    };
    const value = { refund };
    if (idempotency_key) this._payments.set('rf:' + idempotency_key, { ok: true, value });
    return value;
  }

  /** Razorpay's own webhook/callback signature scheme, verified the way they document it. */
  verifyPaymentSignature({ order_id, payment_id, signature }) {
    if (!this.keySecret) return { valid: false, reason: 'no_secret_configured' };
    const expected = crypto.createHmac('sha256', this.keySecret).update(`${order_id}|${payment_id}`).digest('hex');
    return { valid: expected === signature, reason: expected === signature ? null : 'signature_mismatch' };
  }
}

export const razorpay = new RazorpayClient();
