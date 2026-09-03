import { canonical, hmac, safeEqual, id, nowISO } from './util.js';
import { byId } from './catalog.js';

const SECRET = process.env.MANDATE_SECRET || 'dev-mandate-secret-change-me';

/**
 * Merchant-side spending policy. This is the merchant's contract with every AI buyer:
 * what an agent may do without a human, what needs a human, and what is never allowed.
 * All amounts are integer paise.
 */
export const MERCHANT_POLICY = {
  per_txn_review_over: 500000,      // > INR 5,000 -> hold for human approval
  per_txn_hard_cap: 2500000,        // > INR 25,000 -> refuse outright, no override path
  agent_daily_cap: 5000000,         // INR 50,000 total agent-initiated spend per day
  velocity: { max_actions: 5, window_ms: 60_000 },
  max_discount_bps: 1500,           // agents may never discount more than 15%
  min_post_discount_margin_bps: 1200,
  require_idempotency: true,
  absolute_ceiling: 10000000,       // sanity bound: nothing over INR 1,00,000, ever
};

// ---------------------------------------------------------------------------
// Mandates (AP2-style delegated authority)
// ---------------------------------------------------------------------------

/**
 * A mandate is the buyer's signed grant of authority to an agent. It is the answer to
 * "who said this agent could spend this money, and how much". Signed with HMAC-SHA256
 * locally -- no external service, no cost. In production this would be an asymmetric
 * signature from the buyer's wallet so the merchant need not share a secret.
 */
export function mintMandate(spec = {}) {
  const body = {
    mandate_id: id('mnd'),
    version: '1.0',
    buyer_agent: spec.buyer_agent || 'agent:unknown',
    on_behalf_of: spec.on_behalf_of || 'cust:anonymous',
    max_amount_minor: spec.max_amount_minor ?? 500000,
    currency: 'INR',
    allowed_categories: spec.allowed_categories || ['coffee', 'accessories', 'brew-gear', 'subscription'],
    max_items: spec.max_items ?? 10,
    single_use: spec.single_use !== false,
    issued_at: nowISO(),
    expires_at: new Date(Date.now() + (spec.ttl_ms ?? 15 * 60_000)).toISOString(),
    nonce: id('nonce'),
  };
  const sig = hmac(SECRET, canonical(body));
  const token = Buffer.from(JSON.stringify(body)).toString('base64url') + '.' + sig;
  return { mandate: body, token };
}

export function verifyMandate(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'malformed_token', mandate: null };
  }
  const idx = token.lastIndexOf('.');
  const [b64, sig] = [token.slice(0, idx), token.slice(idx + 1)];
  let body;
  try {
    body = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'undecodable_payload', mandate: null };
  }
  if (!safeEqual(hmac(SECRET, canonical(body)), sig)) {
    return { valid: false, reason: 'bad_signature', mandate: body };
  }
  return { valid: true, reason: null, mandate: body };
}

// ---------------------------------------------------------------------------
// Rule stack
// ---------------------------------------------------------------------------

const DENY = 'deny';
const REVIEW = 'review';
const ALLOW = 'allow';
const RANK = { allow: 0, review: 1, deny: 2 };

/**
 * Each rule inspects the action context and returns null (nothing to say) or a finding.
 * Rules never mutate state and never talk to the network, so a decision is reproducible
 * from its inputs -- which is what makes the audit trail meaningful.
 */
export const RULES = [
  {
    id: 'money.currency',
    title: 'Currency must match the merchant account',
    evaluate: (c) => c.currency !== 'INR'
      ? { verdict: DENY, reason: `Merchant settles in INR, action was in ${c.currency}.` }
      : null,
  },
  {
    id: 'money.sane_amount',
    title: 'Amount must be a positive integer within the absolute ceiling',
    evaluate: (c) => {
      if (!Number.isInteger(c.amount_minor) || c.amount_minor <= 0) {
        return { verdict: DENY, reason: `Amount ${c.amount_minor} is not a positive integer in paise.` };
      }
      if (c.amount_minor > MERCHANT_POLICY.absolute_ceiling) {
        return { verdict: DENY, reason: `Amount exceeds the absolute ceiling of ${money(MERCHANT_POLICY.absolute_ceiling)}.`,
          bound: { limit: MERCHANT_POLICY.absolute_ceiling, actual: c.amount_minor } };
      }
      return null;
    },
  },
  {
    id: 'idem.required',
    title: 'Every money action carries an idempotency key',
    evaluate: (c) => MERCHANT_POLICY.require_idempotency && !c.idempotency_key
      ? { verdict: DENY, reason: 'No idempotency key supplied; a retry could double-charge.' }
      : null,
  },
  {
    id: 'agent.mandate_required',
    title: 'Agent-initiated spend requires a signed mandate',
    evaluate: (c) => c.actor.type === 'agent' && !c.mandate_check
      ? { verdict: DENY, reason: 'An agent tried to spend with no mandate presented.' }
      : null,
  },
  {
    id: 'mandate.signature',
    title: 'Mandate signature must verify',
    evaluate: (c) => c.mandate_check && !c.mandate_check.valid
      ? { verdict: DENY, reason: `Mandate rejected: ${c.mandate_check.reason}.` }
      : null,
  },
  {
    id: 'mandate.expiry',
    title: 'Mandate must not be expired',
    evaluate: (c) => {
      const m = validMandate(c);
      if (!m) return null;
      return Date.parse(m.expires_at) < Date.now()
        ? { verdict: DENY, reason: `Mandate expired at ${m.expires_at}.`, bound: { expires_at: m.expires_at } }
        : null;
    },
  },
  {
    id: 'mandate.amount_cap',
    title: 'Charge must fit inside the mandate ceiling',
    evaluate: (c) => {
      const m = validMandate(c);
      if (!m) return null;
      return c.amount_minor > m.max_amount_minor
        ? { verdict: DENY,
            reason: `Charge ${money(c.amount_minor)} exceeds the mandate ceiling of ${money(m.max_amount_minor)}.`,
            bound: { limit: m.max_amount_minor, actual: c.amount_minor } }
        : null;
    },
  },
  {
    id: 'mandate.categories',
    title: 'Every line item must sit in an allowed category',
    evaluate: (c) => {
      const m = validMandate(c);
      if (!m || !c.cart) return null;
      const bad = c.cart.items.filter((i) => !m.allowed_categories.includes(i.category));
      return bad.length
        ? { verdict: DENY,
            reason: `Mandate does not cover category "${bad[0].category}" (item: ${bad[0].title}).`,
            bound: { allowed: m.allowed_categories, offending: bad.map((b) => b.product_id) } }
        : null;
    },
  },
  {
    id: 'mandate.item_cap',
    title: 'Item count must fit inside the mandate',
    evaluate: (c) => {
      const m = validMandate(c);
      if (!m || !c.cart) return null;
      const units = c.cart.items.reduce((s, i) => s + i.qty, 0);
      return units > m.max_items
        ? { verdict: DENY, reason: `${units} units exceeds the mandate limit of ${m.max_items}.`,
            bound: { limit: m.max_items, actual: units } }
        : null;
    },
  },
  {
    id: 'mandate.replay',
    title: 'A single-use mandate cannot be spent twice',
    evaluate: (c) => {
      const m = validMandate(c);
      if (!m || !m.single_use) return null;
      return c.counters.consumed_nonces.has(m.nonce)
        ? { verdict: DENY, reason: 'This single-use mandate has already been spent (replay attempt).',
            bound: { nonce: m.nonce } }
        : null;
    },
  },
  {
    id: 'inventory.sufficient',
    title: 'Stock must cover the cart',
    evaluate: (c) => {
      if (!c.cart) return null;
      for (const i of c.cart.items) {
        const p = byId(i.product_id);
        if (!p) return { verdict: DENY, reason: `Unknown product ${i.product_id}.` };
        if (p.stock < i.qty) {
          return { verdict: DENY, reason: `Only ${p.stock} of "${p.title}" left; cart asks for ${i.qty}.`,
            bound: { available: p.stock, requested: i.qty } };
        }
      }
      return null;
    },
  },
  {
    id: 'discount.cap',
    title: 'Agent discounts are capped to protect margin',
    evaluate: (c) => {
      if (!c.cart || !c.cart.discount_minor) return null;
      const bps = Math.round((c.cart.discount_minor / c.cart.subtotal) * 10000);
      if (bps > MERCHANT_POLICY.max_discount_bps) {
        return { verdict: DENY,
          reason: `Discount of ${(bps / 100).toFixed(1)}% exceeds the ${(MERCHANT_POLICY.max_discount_bps / 100).toFixed(0)}% agent cap.`,
          bound: { limit_bps: MERCHANT_POLICY.max_discount_bps, actual_bps: bps } };
      }
      return null;
    },
  },
  {
    id: 'discount.margin_floor',
    title: 'A discount may not push blended margin below the floor',
    evaluate: (c) => {
      if (!c.cart || !c.cart.discount_minor) return null;
      const grossMargin = c.cart.items.reduce((s, i) => {
        const p = byId(i.product_id);
        return s + (p ? Math.round(p.price * i.qty * (p.margin_bps / 10000)) : 0);
      }, 0);
      const after = grossMargin - c.cart.discount_minor;
      const bps = c.cart.subtotal ? Math.round((after / c.cart.subtotal) * 10000) : 0;
      if (bps < MERCHANT_POLICY.min_post_discount_margin_bps) {
        return { verdict: DENY,
          reason: `Post-discount margin of ${(bps / 100).toFixed(1)}% falls under the ${(MERCHANT_POLICY.min_post_discount_margin_bps / 100).toFixed(0)}% floor.`,
          bound: { floor_bps: MERCHANT_POLICY.min_post_discount_margin_bps, actual_bps: bps } };
      }
      return null;
    },
  },
  {
    id: 'merchant.hard_cap',
    title: 'Per-transaction hard cap',
    evaluate: (c) => c.amount_minor > MERCHANT_POLICY.per_txn_hard_cap
      ? { verdict: DENY,
          reason: `${money(c.amount_minor)} is over the ${money(MERCHANT_POLICY.per_txn_hard_cap)} hard cap; no approval can override this.`,
          bound: { limit: MERCHANT_POLICY.per_txn_hard_cap, actual: c.amount_minor } }
      : null,
  },
  {
    id: 'merchant.review_threshold',
    title: 'Large transactions need a human',
    evaluate: (c) => c.amount_minor > MERCHANT_POLICY.per_txn_review_over
      ? { verdict: REVIEW,
          reason: `${money(c.amount_minor)} is over the ${money(MERCHANT_POLICY.per_txn_review_over)} auto-approve limit, so a human signs this one off.`,
          bound: { limit: MERCHANT_POLICY.per_txn_review_over, actual: c.amount_minor } }
      : null,
  },
  {
    id: 'merchant.daily_agent_cap',
    title: 'Daily agent spend budget',
    evaluate: (c) => {
      if (c.actor.type !== 'agent') return null;
      const after = c.counters.agent_spend_today + c.amount_minor;
      if (after > MERCHANT_POLICY.agent_daily_cap) {
        return { verdict: DENY,
          reason: `Agent spend today would reach ${money(after)}, past the ${money(MERCHANT_POLICY.agent_daily_cap)} daily budget.`,
          bound: { limit: MERCHANT_POLICY.agent_daily_cap, actual: after } };
      }
      if (after > MERCHANT_POLICY.agent_daily_cap * 0.8) {
        return { verdict: REVIEW,
          reason: `This charge takes agent spend to ${money(after)}, inside the top 20% of the daily budget.`,
          bound: { limit: MERCHANT_POLICY.agent_daily_cap, actual: after } };
      }
      return null;
    },
  },
  {
    id: 'merchant.velocity',
    title: 'Rate limit on agent money actions',
    evaluate: (c) => {
      if (c.actor.type !== 'agent') return null;
      const { max_actions, window_ms } = MERCHANT_POLICY.velocity;
      const recent = c.counters.recent_actions.filter((t) => Date.now() - t < window_ms).length;
      return recent >= max_actions
        ? { verdict: REVIEW,
            reason: `${recent} money actions from this agent in the last ${window_ms / 1000}s; pausing for a human look.`,
            bound: { limit: max_actions, actual: recent, window_ms } }
        : null;
    },
  },
];

function validMandate(c) {
  return c.mandate_check && c.mandate_check.valid ? c.mandate_check.mandate : null;
}

const money = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Run the full stack. Returns the decision plus the complete trace -- including rules
 * that passed -- because "why was this allowed" is as much an audit question as
 * "why was this blocked".
 */
export function evaluate(ctx) {
  const c = {
    currency: 'INR',
    cart: null,
    idempotency_key: null,
    mandate_check: null,
    counters: { agent_spend_today: 0, recent_actions: [], consumed_nonces: new Set() },
    ...ctx,
  };

  const trace = [];
  let verdict = ALLOW;

  for (const rule of RULES) {
    let finding = null;
    try {
      finding = rule.evaluate(c);
    } catch (e) {
      // A rule that throws is treated as a failure to prove safety, never as a pass.
      finding = { verdict: DENY, reason: `Rule ${rule.id} could not be evaluated: ${e.message}` };
    }
    const row = finding
      ? { id: rule.id, title: rule.title, verdict: finding.verdict, reason: finding.reason, bound: finding.bound || null }
      : { id: rule.id, title: rule.title, verdict: ALLOW, reason: 'Passed.', bound: null };
    trace.push(row);
    if (RANK[row.verdict] > RANK[verdict]) verdict = row.verdict;
  }

  const blocking = trace.filter((r) => r.verdict === DENY);
  const holds = trace.filter((r) => r.verdict === REVIEW);

  let summary;
  if (verdict === DENY) summary = blocking[0].reason;
  else if (verdict === REVIEW) summary = holds[0].reason;
  else summary = `Within all ${trace.length} policy bounds; cleared for ${money(c.amount_minor)}.`;

  return {
    verdict,
    summary,
    action: c.action,
    amount_minor: c.amount_minor,
    actor: `${c.actor.type}:${c.actor.id}`,
    evaluated_at: nowISO(),
    rules_evaluated: trace.length,
    rules_passed: trace.filter((r) => r.verdict === ALLOW).length,
    blocking: blocking.map((r) => ({ id: r.id, reason: r.reason, bound: r.bound })),
    holds: holds.map((r) => ({ id: r.id, reason: r.reason, bound: r.bound })),
    trace,
  };
}
