import { store } from './store.js';
import { ledger } from './ledger.js';
import { razorpay, RazorpayError, INSTRUMENTS } from './razorpay.js';
import { evaluate, verifyMandate, MERCHANT_POLICY } from './policy.js';
import { offersFor, matchCampaigns } from './growth.js';
import { id, nowISO } from './util.js';

/**
 * The money rail.
 *
 * Every path through this file obeys the same four-step shape:
 *   1. price the cart from source data (never trust a client-supplied amount)
 *   2. put the proposed action through the policy engine
 *   3. write the decision to the hash-chained ledger BEFORE acting on it
 *   4. act -- and if the act fails, run the compensating transaction and log that too
 *
 * Nothing here charges without a policy verdict recorded first.
 */

export function quote(session_id) {
  const s = store.session(session_id);
  if (!s) throw new Error('unknown session');
  const cart = store.priceCart(session_id);
  const offers = offersFor(cart);
  const campaigns = matchCampaigns(s, cart);
  s.offers_shown = offers.map((o) => o.product_id);
  return { cart, offers, campaigns, policy: publicPolicy() };
}

export function publicPolicy() {
  return {
    per_txn_auto_approve_limit_minor: MERCHANT_POLICY.per_txn_review_over,
    per_txn_hard_cap_minor: MERCHANT_POLICY.per_txn_hard_cap,
    agent_daily_cap_minor: MERCHANT_POLICY.agent_daily_cap,
    max_agent_discount_bps: MERCHANT_POLICY.max_discount_bps,
    velocity: MERCHANT_POLICY.velocity,
    idempotency_required: MERCHANT_POLICY.require_idempotency,
    note: 'Actions above the auto-approve limit are held for a human. Actions above the hard cap are refused outright and cannot be approved.',
  };
}

/**
 * A discount is a money action -- it spends margin. It goes through exactly the same
 * gate as a charge, which is how an agent is stopped from discounting its way to a sale.
 */
export function applyCampaignIncentive(session_id, campaign_id, actor) {
  const s = store.session(session_id);
  if (!s) throw new Error('unknown session');
  const cart = store.priceCart(session_id);
  const match = matchCampaigns(s, cart).find((c) => c.campaign_id === campaign_id);
  if (!match) return { status: 'not_applicable', reason: `Campaign ${campaign_id} does not match this cart right now.` };
  if (!match.discount_bps) return { status: 'nudge_only', message: match.message, campaign_id };

  const bps = Math.min(match.discount_bps, match.max_discount_bps, MERCHANT_POLICY.max_discount_bps);
  const discount = Math.round(cart.subtotal * (bps / 10000));
  const probe = { ...cart, discount_minor: discount };

  const decision = evaluate({
    action: 'apply_discount',
    amount_minor: discount,
    actor,
    cart: probe,
    idempotency_key: `disc:${session_id}:${campaign_id}`,
    mandate_check: s.mandate_token ? verifyMandate(s.mandate_token) : null,
    counters: store.counters(actor.id),
  });

  ledger.append('campaign.evaluated', {
    actor, session_id, amount: discount, decision,
    severity: decision.verdict === 'deny' ? 'warn' : 'info',
    payload: { campaign_id, discount_bps: bps, cart_subtotal_minor: cart.subtotal },
  });

  if (decision.verdict === 'deny') {
    return { status: 'blocked', decision, message: decision.summary };
  }

  store.setDiscount(session_id, discount, `${campaign_id} (${(bps / 100).toFixed(1)}%)`);
  ledger.append('campaign.applied', {
    actor, session_id, amount: discount, decision,
    payload: { campaign_id, discount_bps: bps, message: match.message },
  });
  return { status: 'applied', discount_minor: discount, discount_bps: bps, message: match.message, decision, cart: store.priceCart(session_id) };
}

/**
 * Main entry point for "take my money".
 *
 * Returns one of:
 *   { status: 'paid' }              charge captured, order confirmed
 *   { status: 'denied' }            policy refused; nothing was reserved or charged
 *   { status: 'pending_approval' }  policy held it for a human; nothing charged yet
 *   { status: 'failed' }            gateway declined; stock released, cart intact, recovery offered
 *   { status: 'replayed' }          idempotency key seen before; the original outcome returned
 */
export async function checkout({ session_id, instrument = 'card_success', idempotency_key, mandate_token, actor }) {
  const s = store.session(session_id);
  if (!s) throw new Error('unknown session');
  actor = actor || s.actor;

  const replay = store.recallResult(idempotency_key);
  if (replay) {
    ledger.append('payment.replay_suppressed', {
      actor, session_id, order_id: replay.order_id || null,
      payload: { idempotency_key, note: 'Key already used. Returning the original outcome instead of charging again.', original_status: replay.status },
    });
    return { ...replay, status: replay.status, replayed: true };
  }

  const cart = store.priceCart(session_id);
  if (!cart.items.length) return { status: 'denied', reason: 'empty_cart', message: 'There is nothing in the cart to pay for.' };

  const token = mandate_token || s.mandate_token;
  const mandate_check = token ? verifyMandate(token) : null;
  const counters = store.counters(actor.id);

  ledger.append('checkout.requested', {
    actor, session_id, amount: cart.total,
    payload: { instrument, idempotency_key, items: cart.items.map((i) => ({ id: i.product_id, qty: i.qty })), mode: razorpay.mode },
  });

  const decision = evaluate({
    action: 'authorize_payment',
    amount_minor: cart.total,
    actor,
    cart,
    idempotency_key,
    mandate_check,
    counters,
  });

  // The decision is recorded before anything acts on it, so the log cannot be
  // rewritten to justify a charge after the fact.
  ledger.append('policy.evaluated', {
    actor, session_id, amount: cart.total, decision,
    severity: decision.verdict === 'deny' ? 'warn' : 'info',
    payload: { rules_evaluated: decision.rules_evaluated, rules_passed: decision.rules_passed, verdict: decision.verdict },
  });

  if (decision.verdict === 'deny') {
    ledger.append('payment.blocked', {
      actor, session_id, amount: cart.total, decision, severity: 'warn',
      payload: { blocked_by: decision.blocking.map((b) => b.id), reason: decision.summary },
    });
    const out = { status: 'denied', decision, message: decision.summary, cart };
    store.rememberResult(idempotency_key, out);
    return out;
  }

  if (decision.verdict === 'review') {
    const approval = store.createApproval({
      id: id('apr'),
      state: 'pending',
      created_at: nowISO(),
      session_id,
      amount_minor: cart.total,
      actor,
      instrument,
      idempotency_key,
      mandate_token: token,
      decision,
      cart_snapshot: cart,
    });
    s.state = 'awaiting_approval';
    ledger.append('approval.requested', {
      actor, session_id, amount: cart.total, decision, severity: 'warn',
      payload: { approval_id: approval.id, held_by: decision.holds.map((h) => h.id), reason: decision.summary },
    });
    return {
      status: 'pending_approval',
      approval_id: approval.id,
      decision,
      message: `${decision.summary} Nothing has been charged. A human needs to approve this before it goes through.`,
      cart,
    };
  }

  return executePayment({ session: s, cart, instrument, idempotency_key, actor, decision, mandate_check });
}

/** Human decision on a held payment. Approval clears a hold; it can never clear a deny. */
export async function resolveApproval({ approval_id, approve, approver = 'merchant:owner', note = '' }) {
  const a = store.approvals.get(approval_id);
  if (!a) throw new Error('unknown approval');
  if (a.state !== 'pending') return { status: 'already_resolved', state: a.state };

  const humanActor = { type: 'human', id: approver };

  if (!approve) {
    a.state = 'rejected';
    a.resolved_at = nowISO();
    ledger.append('approval.rejected', {
      actor: humanActor, session_id: a.session_id, amount: a.amount_minor, severity: 'warn',
      payload: { approval_id, note, original_actor: `${a.actor.type}:${a.actor.id}` },
    });
    const s = store.session(a.session_id);
    if (s) s.state = 'cart';
    return { status: 'rejected', message: 'A human rejected this payment. Nothing was charged.' };
  }

  a.state = 'approved';
  a.resolved_at = nowISO();
  a.approver = approver;

  const s = store.session(a.session_id);
  const cart = store.priceCart(a.session_id);

  // Re-run policy at approval time: the cart or stock may have moved while it waited.
  // A human can clear a `review` hold. A `deny` still stands -- no override exists.
  const recheck = evaluate({
    action: 'authorize_payment',
    amount_minor: cart.total,
    actor: a.actor,
    cart,
    idempotency_key: a.idempotency_key,
    mandate_check: a.mandate_token ? verifyMandate(a.mandate_token) : null,
    counters: store.counters(a.actor.id),
  });

  ledger.append('approval.granted', {
    actor: humanActor, session_id: a.session_id, amount: cart.total, decision: recheck,
    payload: { approval_id, note, revalidated: true, verdict_at_approval: recheck.verdict },
  });

  if (recheck.verdict === 'deny') {
    ledger.append('payment.blocked', {
      actor: humanActor, session_id: a.session_id, amount: cart.total, decision: recheck, severity: 'warn',
      payload: { reason: recheck.summary, note: 'Conditions changed while the approval was pending. Human approval does not override a hard deny.' },
    });
    return { status: 'denied', decision: recheck, message: recheck.summary };
  }

  return executePayment({
    session: s, cart, instrument: a.instrument, idempotency_key: a.idempotency_key,
    actor: a.actor, decision: recheck, approved_by: approver,
    mandate_check: a.mandate_token ? verifyMandate(a.mandate_token) : null,
  });
}

/**
 * Reserve stock, create the Razorpay objects, charge, and -- on failure -- undo the
 * reservation. The compensating release is the difference between a failed payment
 * and a phantom out-of-stock.
 */
async function executePayment({ session, cart, instrument, idempotency_key, actor, decision, mandate_check, approved_by = null }) {
  const s = session;
  const order_id = id('ord');

  const held = store.reserve(order_id, cart.items.map((i) => ({ product_id: i.product_id, qty: i.qty })));
  if (!held.ok) {
    ledger.append('inventory.reserve_failed', {
      actor, session_id: s.id, order_id, amount: cart.total, severity: 'warn',
      payload: { product_id: held.product_id, available: held.available },
    });
    return { status: 'denied', message: `Stock moved while checking out: only ${held.available} left of that item.`, cart };
  }
  ledger.append('inventory.reserved', {
    actor, session_id: s.id, order_id,
    payload: { reservation_id: held.reservation_id, lines: cart.items.map((i) => ({ id: i.product_id, qty: i.qty })) },
  });

  const order = store.createOrder({
    id: order_id, session_id: s.id, state: 'created', created_at: nowISO(),
    items: cart.items, subtotal: cart.subtotal, discount_minor: cart.discount_minor,
    shipping_minor: cart.shipping_minor, total: cart.total, currency: 'INR',
    actor, instrument, idempotency_key, reservation_id: held.reservation_id,
    approved_by,
    upsell_attached: s.offers_accepted.length > 0,
    agent_attributed_minor: s.offers_accepted.reduce((sum, o) => sum + o.price_minor, 0),
  });

  try {
    const rzpOrder = await razorpay.createOrder({
      amount: cart.total,
      receipt: order_id,
      notes: { session_id: s.id, actor: `${actor.type}:${actor.id}`, policy_verdict: decision.verdict },
    });
    order.razorpay_order_id = rzpOrder.id;
    ledger.append('razorpay.order.created', {
      actor, session_id: s.id, order_id, amount: cart.total,
      payload: { razorpay_order_id: rzpOrder.id, mode: razorpay.mode, receipt: order_id },
    });

    const link = await razorpay.createPaymentLink({
      amount: cart.total,
      description: `Bluebrew order ${order_id}`,
      reference_id: order_id,
      customer: { name: actor.type === 'agent' ? 'AI Buyer' : 'Shopper' },
    });
    order.payment_link = link.short_url;
    ledger.append('razorpay.payment_link.created', {
      actor, session_id: s.id, order_id, amount: cart.total,
      payload: { payment_link_id: link.id, short_url: link.short_url, mode: razorpay.mode },
    });

    const res = await razorpay.authorizeAndCapture({
      order_id: rzpOrder.id, amount: cart.total, instrument, idempotency_key,
    });

    // -- success path ----------------------------------------------------
    store.commit(held.reservation_id);
    order.state = 'paid';
    order.payment_id = res.payment.id;
    order.paid_at = nowISO();
    s.state = 'paid';

    if (mandate_check && mandate_check.valid && mandate_check.mandate.single_use) {
      store.consumeNonce(mandate_check.mandate.nonce);
      ledger.append('mandate.consumed', {
        actor, session_id: s.id, order_id,
        payload: { mandate_id: mandate_check.mandate.mandate_id, nonce: mandate_check.mandate.nonce, note: 'Single-use mandate burned; a replay of this token will now be denied.' },
      });
    }
    store.recordSpend(actor.id, cart.total);
    store.recordAction(actor.id);

    ledger.append('payment.captured', {
      actor, session_id: s.id, order_id, amount: cart.total, decision,
      payload: { payment_id: res.payment.id, method: res.payment.method, instrument, mode: razorpay.mode, approved_by },
    });
    ledger.append('order.confirmed', {
      actor, session_id: s.id, order_id, amount: cart.total,
      payload: { items: cart.items.map((i) => ({ id: i.product_id, qty: i.qty })), total_minor: cart.total, dispatch_sla_hours: 24 },
    });

    const out = {
      status: 'paid', order_id, payment_id: res.payment.id, amount_minor: cart.total,
      razorpay_order_id: rzpOrder.id, payment_link: link.short_url, mode: razorpay.mode,
      decision, approved_by, trail: ledger.trail(order_id),
      message: `Paid ${money(cart.total)}. Order ${order_id} confirmed.`,
    };
    store.rememberResult(idempotency_key, out);
    return out;

  } catch (err) {
    if (!(err instanceof RazorpayError)) throw err;

    // -- failure path: compensate, log, and hand back a real way forward ---
    const released = store.release(held.reservation_id);
    order.state = 'payment_failed';
    order.failure = { reason: err.reason, description: err.envelope.description, at: nowISO() };
    s.state = 'cart';   // the cart survives the failure; the customer loses nothing

    ledger.append('payment.failed', {
      actor, session_id: s.id, order_id, amount: cart.total, decision, severity: 'error',
      payload: {
        reason: err.reason, code: err.envelope.code, description: err.envelope.description,
        step: err.envelope.step, source: err.envelope.source, instrument,
        retryable: err.retryable, replayed: err.replayed === true, mode: razorpay.mode,
      },
    });
    ledger.append('inventory.released', {
      actor, session_id: s.id, order_id,
      payload: { reservation_id: held.reservation_id, restored: released.restored || [], note: 'Compensating transaction: stock held for this order was returned because the charge did not complete.' },
    });

    const alternatives = Object.entries(INSTRUMENTS)
      .filter(([k, v]) => v.outcome === 'captured' && k !== instrument)
      .map(([k, v]) => ({ instrument: k, label: v.label, method: v.method }));

    const out = {
      status: 'failed',
      order_id,
      amount_minor: cart.total,
      cart,
      error: {
        code: err.envelope.code, reason: err.reason, description: err.envelope.description,
        step: err.envelope.step, source: err.envelope.source,
      },
      recovery: {
        retryable: err.retryable,
        advice: err.envelope.advice || 'Try a different payment instrument.',
        retry_same_key: err.retryable
          ? 'This fault was transient. Retrying with the SAME idempotency key is safe and will not double-charge.'
          : 'This decline is final for this instrument. Use a NEW idempotency key with a different instrument.',
        alternatives,
        cart_preserved: true,
        stock_released: released.ok,
      },
      decision,
      trail: ledger.trail(order_id),
      message: `${err.envelope.description} Nothing was charged, your cart is intact, and the stock we were holding has been put back.`,
    };
    store.rememberResult(idempotency_key, out);
    return out;
  }
}

export async function refundOrder({ order_id, amount_minor, reason, actor = { type: 'human', id: 'merchant:owner' }, idempotency_key }) {
  const order = store.order(order_id);
  if (!order) throw new Error('unknown order');
  if (order.state !== 'paid') return { status: 'not_refundable', message: `Order is ${order.state}, not paid.` };

  const amount = amount_minor || order.total;
  const decision = evaluate({
    action: 'refund', amount_minor: amount, actor,
    idempotency_key: idempotency_key || `rf:${order_id}`,
    counters: store.counters(actor.id),
  });
  ledger.append('policy.evaluated', { actor, order_id, amount, decision, payload: { action: 'refund' } });

  if (decision.verdict === 'deny') {
    ledger.append('refund.blocked', { actor, order_id, amount, decision, severity: 'warn', payload: { reason: decision.summary } });
    return { status: 'denied', decision, message: decision.summary };
  }

  const r = await razorpay.refund({ payment_id: order.payment_id, amount, idempotency_key: idempotency_key || `rf:${order_id}` });
  order.state = amount >= order.total ? 'refunded' : 'partially_refunded';
  ledger.append('refund.processed', {
    actor, order_id, amount, decision,
    payload: { refund_id: r.refund.id, reason, replayed: r._replayed === true },
  });
  return { status: 'refunded', refund_id: r.refund.id, amount_minor: amount, trail: ledger.trail(order_id) };
}

const money = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
