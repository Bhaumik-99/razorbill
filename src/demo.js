import { search } from './catalog.js';
import { store } from './store.js';
import { ledger } from './ledger.js';
import { mintMandate } from './policy.js';
import { quote, checkout, publicPolicy } from './checkout.js';

const inr = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Executes the autonomous buyer flow for real and reports what actually happened.
 *
 * This is the same sequence as scripts/buyer-agent.js, run in-process so the web UI can
 * show it. Nothing is scripted: every line below is derived from a genuine call through
 * the policy engine and the payment client, so if behaviour changes, the output changes.
 */
export async function runBuyerDemo({ budget_minor = 350000 } = {}) {
  const steps = [];
  const say = (who, text) => steps.push({ who, text });
  let ok = false;

  const pol = publicPolicy();
  say('buyer', `Goal: light roast beans and a way to brew them. Budget ceiling ${inr(budget_minor)}.`);
  say('shop', `Policy: auto-approve to ${inr(pol.per_txn_auto_approve_limit_minor)}, hard refusal above ${inr(pol.per_txn_hard_cap_minor)}, idempotency key mandatory.`);

  // Mandate, deliberately tighter than what the merchant would permit.
  const { mandate, token } = mintMandate({
    buyer_agent: 'agent:ui-demo-buyer',
    on_behalf_of: 'cust:console',
    max_amount_minor: budget_minor,
    allowed_categories: ['coffee', 'brew-gear', 'accessories'],
    max_items: 5,
    ttl_ms: 10 * 60_000,
  });
  ledger.append('mandate.issued', {
    actor: { type: 'system', id: 'mandate-authority' },
    payload: { mandate_id: mandate.mandate_id, buyer_agent: mandate.buyer_agent, max_amount_minor: mandate.max_amount_minor, via: 'ui_demo' },
  });
  say('buyer', `Minted mandate ${mandate.mandate_id}: ceiling ${inr(mandate.max_amount_minor)}, ${mandate.max_items} items, single-use.`);

  const session = store.createSession({
    actor: { type: 'agent', id: 'agent:ui-demo-buyer' },
    mandate_token: token,
    channel: 'demo',
  });
  ledger.append('session.opened', { actor: session.actor, session_id: session.id, payload: { channel: 'demo' } });

  // Shop against the goal.
  const beans = search({ q: 'light roast beans', category: 'coffee', limit: 3 });
  const gear = search({ q: 'pour over dripper', category: 'brew-gear', max_price: 200000, limit: 3 });
  if (!beans.length || !gear.length) {
    say('shop', 'Catalog returned no match for the goal; aborting.');
    return { ok: false, steps, chain_ok: ledger.verify().ok };
  }
  store.addToCart(session.id, beans[0].id, 1);
  store.addToCart(session.id, gear[0].id, 1);
  say('shop', `Found ${beans[0].title} (${inr(beans[0].price.amount_minor)}) and ${gear[0].title} (${inr(gear[0].price.amount_minor)}).`);

  // Evaluate the merchant's offers against the buyer's own ceiling.
  let q = quote(session.id);
  say('shop', `Quote: subtotal ${inr(q.cart.subtotal)}, shipping ${inr(q.cart.shipping_minor)}, total ${inr(q.cart.total)}.`);

  for (const offer of q.offers) {
    const projected = q.cart.total + offer.price_minor;
    if (offer.type === 'completes' && projected <= budget_minor) {
      store.addToCart(session.id, offer.product_id, 1);
      session.offers_accepted.push({ product_id: offer.product_id, price_minor: offer.price_minor, type: offer.type });
      say('buyer', `Accepted [${offer.type}] +${inr(offer.price_minor)} — ${offer.reason}`);
      q = quote(session.id);
    } else if (projected > budget_minor) {
      say('buyer', `Declined [${offer.type}] +${inr(offer.price_minor)} — would reach ${inr(projected)}, over my ceiling.`);
    } else {
      say('buyer', `Declined [${offer.type}] +${inr(offer.price_minor)} — evidence is sound but off-goal.`);
    }
  }
  say('shop', `Final quote ${inr(q.cart.total)}${q.cart.shipping_minor === 0 ? ' (free shipping earned)' : ''}.`);

  // Pay with an instrument that is known to decline, then recover.
  const key1 = 'uidemo-' + Date.now() + '-a';
  let pay = await checkout({ session_id: session.id, instrument: 'card_insufficient_funds', idempotency_key: key1, mandate_token: token, actor: session.actor });

  if (pay.status === 'failed') {
    say('shop', `DECLINED — ${pay.error.description} (${pay.error.reason} at ${pay.error.step})`);
    say('shop', `Compensation ran: stock released ${pay.recovery.stock_released}, cart preserved ${pay.recovery.cart_preserved}.`);

    const replay = await checkout({ session_id: session.id, instrument: 'card_insufficient_funds', idempotency_key: key1, mandate_token: token, actor: session.actor });
    say('buyer', `Replayed the same idempotency key — returned "${replay.status}"${replay.replayed ? ' from the stored record, no second gateway call' : ''}.`);

    const alt = pay.recovery.alternatives.find((a) => a.method === 'upi') || pay.recovery.alternatives[0];
    const key2 = 'uidemo-' + Date.now() + '-b';
    say('buyer', `Switching to ${alt.label} under a fresh key.`);
    pay = await checkout({ session_id: session.id, instrument: alt.instrument, idempotency_key: key2, mandate_token: token, actor: session.actor });
  }

  if (pay.status === 'paid') {
    ok = true;
    say('shop', `PAID ${inr(pay.amount_minor)} — order ${pay.order_id}, payment ${pay.payment_id} (${pay.mode}).`);
  } else {
    say('shop', `Ended as "${pay.status}" — ${pay.message}`);
  }

  // The single-use mandate must now be refused.
  store.addToCart(session.id, beans[0].id, 1);
  const replayAttack = await checkout({
    session_id: session.id, instrument: 'upi_success',
    idempotency_key: 'uidemo-replay-' + Date.now(), mandate_token: token, actor: session.actor,
  });
  say('buyer', 'Reusing the burnt single-use mandate on a fresh cart.');
  say('shop', `${replayAttack.status.toUpperCase()} — ${replayAttack.message}`);

  const chain = ledger.verify();
  say('shop', `Ledger: ${chain.ok ? 'chain valid' : 'CHAIN BROKEN at #' + chain.broken_at}, ${ledger.entries.length} entries total.`);

  return { ok, steps, chain_ok: chain.ok, order_id: pay.order_id || null, session_id: session.id };
}
