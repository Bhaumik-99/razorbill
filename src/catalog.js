import { rng, pick } from './util.js';

export const MERCHANT = {
  id: 'mrch_bluebrew',
  name: 'Bluebrew Coffee Co.',
  legal_name: 'Bluebrew Roasters Pvt Ltd',
  country: 'IN',
  currency: 'INR',
  support: 'orders@bluebrew.example',
  timezone: 'Asia/Kolkata',
  fulfilment: { ships_to: ['IN'], free_shipping_threshold: 150000, flat_shipping: 9900, dispatch_sla_hours: 24 },
  tax: { scheme: 'GST', inclusive: true, default_rate_bps: 1800 },
};

/**
 * Prices are integer paise. `margin_bps` is gross margin in basis points of price;
 * the upsell ranker is margin-aware, so it has to live on the product record.
 * `attrs` is the machine-filterable surface an AI buyer reasons over.
 */
export const PRODUCTS = [
  { id: 'bb-v60', sku: 'BB-DRP-V60-02', title: 'Hario V60 02 Ceramic Dripper', category: 'brew-gear',
    price: 129900, margin_bps: 2400, stock: 42, glyph: 'V', tags: ['pour-over', 'dripper', 'ceramic', 'beginner'],
    attrs: { brew_method: 'pour-over', material: 'ceramic', cups: '1-4', needs_filters: true },
    blurb: 'The default pour-over cone. Ceramic holds heat better than plastic.',
    upsell_to: 'bb-v60-set', consumable: ['bb-filters'] },

  { id: 'bb-v60-set', sku: 'BB-DRP-V60-SET', title: 'Hario V60 Starter Set (Dripper + Carafe + Filters)', category: 'brew-gear',
    price: 299900, margin_bps: 2900, stock: 18, glyph: 'S', tags: ['pour-over', 'set', 'gift', 'bundle'],
    attrs: { brew_method: 'pour-over', material: 'ceramic+glass', cups: '1-4', needs_filters: false },
    blurb: 'Everything for pour-over in one box. Cheaper than the parts bought separately.',
    consumable: ['bb-filters'] },

  { id: 'bb-aeropress', sku: 'BB-BRW-AP-GO', title: 'AeroPress Go Travel Press', category: 'brew-gear',
    price: 449900, margin_bps: 2100, stock: 27, glyph: 'A', tags: ['aeropress', 'travel', 'immersion', 'durable'],
    attrs: { brew_method: 'immersion', material: 'polypropylene', cups: '1', travel: true },
    blurb: 'Unbreakable, packs into its own mug. The one you take on trains.',
    consumable: ['bb-ap-filters'] },

  { id: 'bb-grinder-hand', sku: 'BB-GRN-JX', title: '1Zpresso JX Hand Grinder', category: 'brew-gear',
    price: 899900, margin_bps: 2600, stock: 12, glyph: 'G', tags: ['grinder', 'manual', 'burr', 'precision'],
    attrs: { grinder_type: 'manual', burr: 'conical steel', settings: 40 },
    blurb: 'Stepped conical burrs. Grind quality that embarrasses machines twice the price.',
    upsell_to: 'bb-grinder-elec' },

  { id: 'bb-grinder-elec', sku: 'BB-GRN-ENC', title: 'Baratza Encore Electric Grinder', category: 'brew-gear',
    price: 1899900, margin_bps: 1900, stock: 6, glyph: 'E', tags: ['grinder', 'electric', 'burr', 'daily-driver'],
    attrs: { grinder_type: 'electric', burr: 'conical steel', settings: 40 },
    blurb: 'The default electric burr grinder. Forty settings, serviceable forever.' },

  { id: 'bb-kettle', sku: 'BB-KTL-GN', title: 'Gooseneck Pour-Over Kettle 1L', category: 'brew-gear',
    price: 349900, margin_bps: 3100, stock: 23, glyph: 'K', tags: ['kettle', 'gooseneck', 'pour-over', 'control'],
    attrs: { capacity_ml: 1000, material: 'stainless steel', stovetop: true },
    blurb: 'Narrow spout, slow pour, actual control over extraction.' },

  { id: 'bb-scale', sku: 'BB-SCL-TM', title: 'Timemore Black Mirror Brew Scale', category: 'brew-gear',
    price: 429900, margin_bps: 2800, stock: 15, glyph: 'W', tags: ['scale', 'timer', 'precision'],
    attrs: { precision_g: 0.1, max_g: 2000, built_in_timer: true },
    blurb: '0.1g precision with a built-in timer. Turns guessing into a recipe.' },

  { id: 'bb-beans-attikan', sku: 'BB-CFE-ATT-250', title: 'Attikan Estate Medium Roast 250g', category: 'coffee',
    price: 74900, margin_bps: 4800, stock: 140, glyph: 'M', tags: ['beans', 'medium', 'chocolate', 'everyday'],
    attrs: { origin: 'Chikmagalur, Karnataka', roast: 'medium', weight_g: 250, notes: 'cocoa, orange peel', process: 'washed' },
    blurb: 'Cocoa and orange peel. The one people re-order without thinking.' },

  { id: 'bb-beans-ratnagiri', sku: 'BB-CFE-RTN-250', title: 'Ratnagiri Peaberry Light Roast 250g', category: 'coffee',
    price: 89900, margin_bps: 4600, stock: 88, glyph: 'L', tags: ['beans', 'light', 'floral', 'filter'],
    attrs: { origin: 'Ratnagiri, Maharashtra', roast: 'light', weight_g: 250, notes: 'jasmine, stone fruit', process: 'natural' },
    blurb: 'Jasmine and stone fruit. Best on a pour-over, wasted in milk.' },

  { id: 'bb-beans-dark', sku: 'BB-CFE-BBG-250', title: 'Baba Budan Dark Roast 250g', category: 'coffee',
    price: 69900, margin_bps: 4900, stock: 165, glyph: 'D', tags: ['beans', 'dark', 'bold', 'milk', 'espresso'],
    attrs: { origin: 'Baba Budangiri, Karnataka', roast: 'dark', weight_g: 250, notes: 'dark chocolate, molasses', process: 'washed' },
    blurb: 'Dark chocolate and molasses. Holds up in milk and in a moka pot.' },

  { id: 'bb-sampler', sku: 'BB-CFE-SMP-3', title: 'Three-Origin Sampler 3 x 100g', category: 'coffee',
    price: 119900, margin_bps: 4400, stock: 60, glyph: 'T', tags: ['beans', 'sampler', 'gift', 'variety'],
    attrs: { weight_g: 300, roasts: 'light/medium/dark', gift_ready: true },
    blurb: 'Three origins, one box. The safe answer when you do not know their taste.' },

  { id: 'bb-filters', sku: 'BB-ACC-FLT-100', title: 'V60 02 Paper Filters (100 ct)', category: 'accessories',
    price: 39900, margin_bps: 5500, stock: 300, glyph: 'F', tags: ['filters', 'paper', 'consumable', 'v60'],
    attrs: { count: 100, fits: ['bb-v60', 'bb-v60-set'], consumable: true },
    blurb: 'Tabbed, bleached, no papery taste. Runs out faster than you expect.' },

  { id: 'bb-ap-filters', sku: 'BB-ACC-APF-350', title: 'AeroPress Paper Filters (350 ct)', category: 'accessories',
    price: 34900, margin_bps: 5600, stock: 210, glyph: 'P', tags: ['filters', 'paper', 'consumable', 'aeropress'],
    attrs: { count: 350, fits: ['bb-aeropress'], consumable: true },
    blurb: 'A year of AeroPress in one tin.' },

  { id: 'bb-cleaner', sku: 'BB-ACC-CLN-30', title: 'Brewer Cleaning Tablets (30 ct)', category: 'accessories',
    price: 54900, margin_bps: 5400, stock: 120, glyph: 'C', tags: ['cleaning', 'maintenance', 'consumable'],
    attrs: { count: 30, consumable: true },
    blurb: 'Strips coffee oils. The reason your brewer stops tasting stale.' },

  { id: 'bb-mug', sku: 'BB-ACC-MUG-250', title: 'Double-Wall Glass Mug 250ml', category: 'accessories',
    price: 89900, margin_bps: 5200, stock: 95, glyph: 'U', tags: ['mug', 'glass', 'gift', 'double-wall'],
    attrs: { capacity_ml: 250, material: 'borosilicate', dishwasher_safe: true },
    blurb: 'Keeps heat in, keeps your hand cool, looks good on a call.' },

  { id: 'bb-sub-monthly', sku: 'BB-SUB-M2', title: 'Monthly Bean Subscription (2 x 250g)', category: 'subscription',
    price: 139900, margin_bps: 5100, stock: 999, glyph: 'R', tags: ['subscription', 'recurring', 'beans', 'ltv'],
    attrs: { cadence: 'monthly', weight_g: 500, cancel_anytime: true, recurring: true },
    blurb: 'Two bags a month, rotating origins. Cancel any time.' },
];

const INDEX = new Map(PRODUCTS.map((p) => [p.id, p]));
export const byId = (pid) => INDEX.get(pid) || null;

/** What an AI buyer sees. Everything needed to decide, nothing merchant-internal. */
export function agentView(p) {
  return {
    id: p.id,
    sku: p.sku,
    title: p.title,
    description: p.blurb,
    category: p.category,
    price: { amount_minor: p.price, currency: 'INR', display: 'INR ' + (p.price / 100).toFixed(2) },
    availability: p.stock > 0 ? 'in_stock' : 'out_of_stock',
    stock_hint: p.stock > 20 ? 'high' : p.stock > 0 ? 'limited' : 'none',
    attributes: p.attrs,
    tags: p.tags,
    agent_purchasable: true,
    max_qty_per_order: p.category === 'subscription' ? 1 : 10,
  };
}

/**
 * Keyword search over title/tags/attrs. Deliberately not a vector index: an AI buyer
 * needs a predictable catalog surface it can filter on, and the merchant needs to be
 * able to explain why a product ranked where it did.
 */
export function search(opts = {}) {
  const { q = '', category = null, max_price = null, min_price = null, tags = [], limit = 8 } = opts;
  const terms = String(q).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  return PRODUCTS
    .map((p) => {
      const hay = [p.title, p.category, p.blurb, ...p.tags, ...Object.values(p.attrs).map(String)]
        .join(' ').toLowerCase();
      let score = 0;
      const matched = [];
      for (const t of terms) {
        if (p.title.toLowerCase().includes(t)) { score += 3; matched.push(t); }
        else if (p.tags.some((x) => x.includes(t))) { score += 2; matched.push(t); }
        else if (hay.includes(t)) { score += 1; matched.push(t); }
      }
      if (terms.length === 0) score = 1;
      return { p, score, matched: [...new Set(matched)] };
    })
    .filter((r) => r.score > 0)
    .filter((r) => !category || r.p.category === category)
    .filter((r) => max_price == null || r.p.price <= max_price)
    .filter((r) => min_price == null || r.p.price >= min_price)
    .filter((r) => tags.length === 0 || tags.some((t) => r.p.tags.includes(t)))
    .sort((a, b) => b.score - a.score || a.p.price - b.p.price)
    .slice(0, limit)
    .map((r) => Object.assign(agentView(r.p), { _match: { score: r.score, terms: r.matched } }));
}

/**
 * Synthetic but structured purchase history. The affinity engine derives its lift
 * numbers from this, so co-purchase patterns are baked in per shopper archetype
 * rather than drawn uniformly at random.
 */
export function orderHistory(n = 420, seed = 20260821) {
  const r = rng(seed);
  const archetypes = [
    { w: 26, core: ['bb-v60'], often: ['bb-filters', 'bb-beans-attikan'], sometimes: ['bb-kettle', 'bb-mug'] },
    { w: 14, core: ['bb-v60-set'], often: ['bb-beans-ratnagiri'], sometimes: ['bb-kettle', 'bb-scale'] },
    { w: 18, core: ['bb-aeropress'], often: ['bb-ap-filters', 'bb-beans-dark'], sometimes: ['bb-mug'] },
    { w: 12, core: ['bb-grinder-hand'], often: ['bb-beans-ratnagiri'], sometimes: ['bb-scale', 'bb-beans-attikan'] },
    { w: 5, core: ['bb-grinder-elec'], often: ['bb-beans-attikan'], sometimes: ['bb-cleaner', 'bb-scale'] },
    { w: 15, core: ['bb-beans-attikan'], often: [], sometimes: ['bb-beans-dark', 'bb-cleaner', 'bb-mug'] },
    { w: 6, core: ['bb-sampler'], often: ['bb-mug'], sometimes: ['bb-sub-monthly'] },
    { w: 4, core: ['bb-sub-monthly'], often: [], sometimes: ['bb-mug', 'bb-cleaner'] },
  ];
  const table = archetypes.flatMap((a) => Array(a.w).fill(a));
  const orders = [];
  for (let i = 0; i < n; i++) {
    const a = pick(r, table);
    const items = new Set(a.core);
    for (const o of a.often) if (r() < 0.68) items.add(o);
    for (const s of a.sometimes) if (r() < 0.24) items.add(s);
    if (r() < 0.06) items.add(pick(r, PRODUCTS).id);
    orders.push([...items]);
  }
  return orders;
}
