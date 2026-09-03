import { byId, PRODUCTS, orderHistory, agentView } from './catalog.js';
import { rng } from './util.js';

/**
 * Market-basket affinity built from order history.
 *
 * support(B)          = share of orders containing B
 * confidence(A -> B)  = share of A-orders that also contain B
 * lift(A -> B)        = confidence / support(B)
 *
 * Lift above 1 means "people who bought A buy B more often than the average shopper
 * does". Every recommendation this file emits carries its lift, confidence and the raw
 * co-order count, so the merchant can audit why a product was pushed -- an opaque
 * recommender is not something you can defend to a customer or a compliance team.
 */
class Affinity {
  constructor(orders) {
    this.n = orders.length;
    this.count = new Map();
    this.pair = new Map();
    for (const o of orders) {
      for (const a of o) {
        this.count.set(a, (this.count.get(a) || 0) + 1);
        for (const b of o) {
          if (a === b) continue;
          const k = a + '>' + b;
          this.pair.set(k, (this.pair.get(k) || 0) + 1);
        }
      }
    }
  }

  support(x) { return (this.count.get(x) || 0) / this.n; }

  stats(a, b) {
    const co = this.pair.get(a + '>' + b) || 0;
    const ca = this.count.get(a) || 0;
    const confidence = ca ? co / ca : 0;
    const supB = this.support(b);
    return { co_orders: co, a_orders: ca, confidence, support_b: supB, lift: supB ? confidence / supB : 0 };
  }

  /** Everything meaningfully co-bought with `a`, strongest first. */
  partners(a, { min_lift = 1.15, min_co = 6 } = {}) {
    const out = [];
    for (const p of PRODUCTS) {
      if (p.id === a) continue;
      const s = this.stats(a, p.id);
      if (s.lift >= min_lift && s.co_orders >= min_co) out.push({ product_id: p.id, ...s });
    }
    return out.sort((x, y) => y.lift * y.confidence - x.lift * x.confidence);
  }
}

export const affinity = new Affinity(orderHistory());

const pct = (x) => (x * 100).toFixed(0) + '%';
const rupees = (p) => 'INR ' + (p / 100).toFixed(0);

/**
 * Build the ranked offer set for a cart.
 *
 * Four offer types, in descending order of how defensible they are:
 *   completes  - the item is a declared consumable of something in the cart (deterministic)
 *   cross_sell - co-purchase affinity above the lift threshold (evidence-backed)
 *   upsell     - a declared higher tier of an item already in the cart
 *   threshold  - an add-on that costs less than the shipping it removes (arithmetic)
 */
export function offersFor(cart, { limit = 3 } = {}) {
  const inCart = new Set(cart.items.map((i) => i.product_id));
  const offers = [];

  for (const line of cart.items) {
    const src = byId(line.product_id);
    if (!src) continue;

    for (const cid of src.consumable || []) {
      if (inCart.has(cid)) continue;
      const c = byId(cid);
      if (!c || c.stock <= 0) continue;
      const s = affinity.stats(src.id, cid);
      offers.push({
        type: 'completes', product_id: cid, anchor_id: src.id,
        headline: `${c.title} — you will need these`,
        reason: `${src.title} takes ${c.title} to work. ${s.co_orders} of the last ${s.a_orders} ${src.title} orders included them.`,
        evidence: { lift: +s.lift.toFixed(2), confidence: +s.confidence.toFixed(3), co_orders: s.co_orders, basis: 'declared_consumable+history' },
        price_minor: c.price,
        accept_prob: clamp(0.35 + s.confidence * 0.5, 0.2, 0.8),
      });
    }

    if (src.upsell_to && !inCart.has(src.upsell_to)) {
      const up = byId(src.upsell_to);
      if (up && up.stock > 0) {
        const delta = up.price - src.price;
        offers.push({
          type: 'upsell', product_id: up.id, anchor_id: src.id, replaces: src.id,
          headline: `Step up to ${up.title}`,
          reason: `${rupees(delta)} more than ${src.title}. ${up.blurb}`,
          evidence: { delta_minor: delta, margin_gain_bps: up.margin_bps - src.margin_bps, basis: 'declared_tier' },
          price_minor: delta,
          accept_prob: delta > 800000 ? 0.08 : delta > 300000 ? 0.14 : 0.22,
        });
      }
    }

    for (const p of affinity.partners(src.id).slice(0, 3)) {
      if (inCart.has(p.product_id) || offers.some((o) => o.product_id === p.product_id)) continue;
      const c = byId(p.product_id);
      if (!c || c.stock <= 0) continue;
      // Do not recommend an add-on that dwarfs the cart; it reads as a bad salesperson.
      if (c.price > cart.subtotal * 1.2) continue;
      offers.push({
        type: 'cross_sell', product_id: c.id, anchor_id: src.id,
        headline: `${c.title}`,
        reason: `Bought together in ${pct(p.confidence)} of ${src.title} orders — ${p.lift.toFixed(1)}x more often than average.`,
        evidence: { lift: +p.lift.toFixed(2), confidence: +p.confidence.toFixed(3), co_orders: p.co_orders, basis: 'market_basket' },
        price_minor: c.price,
        accept_prob: clamp(p.confidence * 0.55, 0.05, 0.45),
      });
    }
  }

  // Free-shipping nudge: only honest when the add-on genuinely costs less than the
  // shipping it removes, so the customer is strictly better off taking it.
  const gap = cart.amount_to_free_shipping;
  if (gap > 0 && cart.items.length) {
    const filler = PRODUCTS
      .filter((p) => !inCart.has(p.id) && p.stock > 0 && p.price >= gap && p.price <= gap + 40000)
      .sort((a, b) => a.price - b.price)[0];
    if (filler && !offers.some((o) => o.product_id === filler.id)) {
      offers.push({
        type: 'threshold', product_id: filler.id, anchor_id: null,
        headline: `${filler.title} gets you free shipping`,
        reason: `You are ${rupees(gap)} short of free delivery. This costs ${rupees(filler.price)} and saves the ${rupees(cart.shipping_minor)} shipping fee.`,
        evidence: { gap_minor: gap, shipping_saved_minor: cart.shipping_minor, basis: 'threshold_arithmetic' },
        price_minor: filler.price,
        accept_prob: 0.3,
      });
    }
  }

  return offers
    .map((o) => {
      const p = byId(o.product_id);
      const margin = Math.round(o.price_minor * (p.margin_bps / 10000));
      return {
        ...o,
        product: agentView(p),
        expected_revenue_minor: Math.round(o.price_minor * o.accept_prob),
        expected_margin_minor: Math.round(margin * o.accept_prob),
      };
    })
    .sort((a, b) => b.expected_margin_minor - a.expected_margin_minor)
    .slice(0, limit);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Campaign orchestrator
// ---------------------------------------------------------------------------

/**
 * Campaigns are rules, not vibes. Each has an explicit trigger, an explicit bounded
 * action, and a cooldown. Any campaign that spends margin (i.e. issues a discount)
 * is a money action and must clear the policy engine before it reaches a customer --
 * see checkout.applyCampaignIncentive.
 */
export const CAMPAIGNS = [
  {
    id: 'recover.stale_cart',
    title: 'Abandoned cart recovery',
    trigger: 'Cart idle past the abandonment window with items still in it',
    max_discount_bps: 800,
    cooldown_ms: 10 * 60_000,
    applies: (s, cart) => cart.items.length > 0 && Date.now() - s.last_activity >= 45_000,
    build: (s, cart) => ({
      kind: 'incentive',
      discount_bps: cart.subtotal >= 300000 ? 800 : 500,
      message: 'Your cart is still here. Here is a small nudge to finish it off.',
    }),
  },
  {
    id: 'grow.threshold_push',
    title: 'Free-shipping threshold push',
    trigger: 'Cart sits just under the free-shipping threshold',
    max_discount_bps: 0,
    cooldown_ms: 60_000,
    applies: (s, cart) => cart.amount_to_free_shipping > 0 && cart.amount_to_free_shipping <= 50000,
    build: (s, cart) => ({
      kind: 'nudge',
      discount_bps: 0,
      message: `Add ${rupees(cart.amount_to_free_shipping)} and delivery is on us.`,
    }),
  },
  {
    id: 'grow.replenish',
    title: 'Consumable replenishment',
    trigger: 'A past order contained a consumable that is due to run out',
    max_discount_bps: 300,
    cooldown_ms: 24 * 3600_000,
    applies: (s, cart) => cart.items.some((i) => (byId(i.product_id)?.attrs || {}).consumable === true),
    build: () => ({ kind: 'nudge', discount_bps: 0, message: 'Running low? Subscribe and never think about it again.' }),
  },
];

export function matchCampaigns(session, cart) {
  return CAMPAIGNS.filter((c) => {
    try { return c.applies(session, cart); } catch { return false; }
  }).map((c) => ({ campaign_id: c.id, title: c.title, trigger: c.trigger, max_discount_bps: c.max_discount_bps, ...c.build(session, cart) }));
}

// ---------------------------------------------------------------------------
// Lift measurement
// ---------------------------------------------------------------------------

/**
 * Replays synthetic sessions twice from the same seed -- once with the growth agent
 * muted (control) and once with it active (treatment) -- and reports the delta.
 *
 * This is a simulation, not a live A/B test. It is honest about acceptance being
 * modelled from the same historical confidences that generate the offers, so treat
 * the numbers as a directional estimate of the mechanism, not a measured result.
 */
export function simulateLift({ sessions = 400, seed = 7 } = {}) {
  const run = (treatment) => {
    const r = rng(seed);
    let revenue = 0, margin = 0, attached = 0, orders = 0, discountSpend = 0;
    for (let i = 0; i < sessions; i++) {
      const seedProduct = PRODUCTS[Math.floor(r() * PRODUCTS.length)];
      const items = [{ product_id: seedProduct.id, qty: 1, unit_price: seedProduct.price, category: seedProduct.category, title: seedProduct.title, line_total: seedProduct.price }];
      let subtotal = seedProduct.price;

      if (treatment) {
        const fakeCart = { items, subtotal, shipping_minor: subtotal >= 150000 ? 0 : 9900, amount_to_free_shipping: Math.max(0, 150000 - subtotal) };
        for (const offer of offersFor(fakeCart, { limit: 2 })) {
          if (r() < offer.accept_prob) {
            const p = byId(offer.product_id);
            items.push({ product_id: p.id, qty: 1, unit_price: p.price, category: p.category, title: p.title, line_total: p.price });
            subtotal += offer.price_minor;
            attached++;
          }
        }
      }

      // Checkout conversion. A recovery incentive lifts completion but costs margin.
      let convert = 0.62;
      let discount = 0;
      if (treatment && r() < 0.3) { convert += 0.09; discount = Math.round(subtotal * 0.05); }
      if (r() > convert) continue;

      orders++;
      const shipping = subtotal - discount >= 150000 ? 0 : 9900;
      const total = subtotal - discount + shipping;
      revenue += total;
      discountSpend += discount;
      margin += items.reduce((s, i) => s + Math.round(i.line_total * (byId(i.product_id).margin_bps / 10000)), 0) - discount;
    }
    return { orders, revenue_minor: revenue, margin_minor: margin, aov_minor: orders ? Math.round(revenue / orders) : 0,
      attach_rate: orders ? +(attached / orders).toFixed(3) : 0, discount_spend_minor: discountSpend };
  };

  const control = run(false);
  const treatment = run(true);
  const d = (a, b) => (a ? +(((b - a) / a) * 100).toFixed(1) : 0);
  return {
    sessions, seed,
    control, treatment,
    delta: {
      revenue_pct: d(control.revenue_minor, treatment.revenue_minor),
      margin_pct: d(control.margin_minor, treatment.margin_minor),
      aov_pct: d(control.aov_minor, treatment.aov_minor),
      conversion_pct: d(control.orders, treatment.orders),
      incremental_revenue_minor: treatment.revenue_minor - control.revenue_minor,
      incremental_margin_minor: treatment.margin_minor - control.margin_minor,
    },
    caveat: 'Simulated replay with a fixed seed. Acceptance is modelled from the same historical confidences that generate the offers, so this estimates the mechanism, not a measured live result.',
  };
}
