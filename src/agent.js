import { search, byId, PRODUCTS, MERCHANT } from './catalog.js';
import { store } from './store.js';
import { ledger } from './ledger.js';
import { quote, checkout, applyCampaignIncentive, publicPolicy } from './checkout.js';
import { INSTRUMENTS } from './razorpay.js';
import { id } from './util.js';

/**
 * Deterministic conversational agent.
 *
 * There is no language model here, on purpose: intent is matched by rule, slots are
 * extracted by regex, and product references resolve by token overlap against the
 * catalog. That makes every reply reproducible and every action traceable to the rule
 * that fired -- which is the whole point when the next step spends money.
 *
 * An LLM would slot in at exactly one seam: `classify()` below, swapping rules for a
 * constrained tool-call. Everything downstream -- policy, mandates, ledger -- is
 * unchanged by that swap, and stays the security boundary regardless.
 */

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const INTENTS = [
  { name: 'greet', patterns: [/^\s*(hi|hey|hello|yo|namaste|good (morning|evening|afternoon))\b/i] },
  { name: 'help', patterns: [/\b(help|what can you do|how does this work|options)\b/i] },
  { name: 'policy', patterns: [/\b(policy|allowed to spend|can you spend|spending limit|limits|bounds|mandate|how much can you)\b/i] },
  { name: 'audit', patterns: [/\b(audit|trail|log|ledger|receipt|proof|history)\b/i] },
  { name: 'view_cart', patterns: [/\b(cart|basket|what.?s in my|my order|total so far)\b/i] },
  { name: 'checkout', patterns: [/\b(checkout|check out|pay|buy it|place (the )?order|complete|purchase now)\b/i] },
  { name: 'remove', patterns: [/\b(remove|delete|take (it|that) out|drop the|get rid of)\b/i] },
  { name: 'add', patterns: [/\b(add|put|include|i.?ll take|give me|want|buy|get me)\b/i] },
  { name: 'recommend', patterns: [/\b(recommend|suggest|what should|surprise me|best|popular|anything else|go with)\b/i] },
  { name: 'accept', patterns: [/^\s*(yes|yeah|yep|sure|ok(ay)?|sounds good|do it|add it|go ahead|please do)\b/i] },
  { name: 'decline', patterns: [/^\s*(no|nope|nah|skip|not now|no thanks)\b/i] },
  { name: 'search', patterns: [/\b(show|find|search|looking for|browse|do you have|got any|what.?s|catalog)\b/i] },
];

function classify(text) {
  for (const it of INTENTS) {
    for (const p of it.patterns) if (p.test(text)) return { intent: it.name, matched: String(p) };
  }
  // No pattern fired, but the message names a product -> treat it as a search.
  return { intent: resolveProduct(text) ? 'search' : 'fallback', matched: null };
}

function extractQty(text) {
  const digit = text.match(/\b(\d{1,2})\s*(x|pcs?|packs?|bags?|units?)?\b/);
  if (digit && +digit[1] > 0 && +digit[1] <= 10) return +digit[1];
  for (const [w, n] of Object.entries(NUM_WORDS)) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(text) && w !== 'a' && w !== 'an') return n;
  }
  return 1;
}

function extractBudget(text) {
  const m = text.match(/\b(?:under|below|less than|max|budget of|upto|up to|within)\s*(?:rs\.?|inr|₹)?\s*([\d,]+)/i);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10) * 100;
  const m2 = text.match(/(?:rs\.?|inr|₹)\s*([\d,]+)/i);
  if (m2) return parseInt(m2[1].replace(/,/g, ''), 10) * 100;
  return null;
}

const CATEGORY_HINTS = {
  coffee: /\b(beans?|coffee|roast|filter coffee|arabica)\b/i,
  'brew-gear': /\b(brewer|dripper|grinder|kettle|scale|aeropress|v60|gear|equipment)\b/i,
  accessories: /\b(filters?|mug|cup|cleaner|cleaning|accessor)\b/i,
  subscription: /\b(subscri|recurring|monthly|every month)\b/i,
};

function extractCategory(text) {
  for (const [cat, re] of Object.entries(CATEGORY_HINTS)) if (re.test(text)) return cat;
  return null;
}

/** Resolve free text to a product by token overlap. Returns the best match or null. */
function resolveProduct(text, candidates = PRODUCTS) {
  const t = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const p of candidates) {
    const tokens = p.title.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2);
    let score = 0;
    for (const tok of tokens) if (t.includes(tok)) score += tok.length;
    for (const tag of p.tags) if (new RegExp(`\\b${tag.replace(/[-]/g, '.?')}\\b`, 'i').test(t)) score += 4;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 4 ? best : null;
}

/** "the second one", "#3", "the first" -> index into the last list shown. */
function resolveOrdinal(text, lastShown) {
  if (!lastShown || !lastShown.length) return null;
  const ords = ['first', 'second', 'third', 'fourth', 'fifth'];
  for (let i = 0; i < ords.length; i++) {
    if (new RegExp(`\\b${ords[i]}\\b`, 'i').test(text)) return lastShown[i] ? byId(lastShown[i]) : null;
  }
  const hash = text.match(/#\s*(\d)/);
  if (hash) return lastShown[+hash[1] - 1] ? byId(lastShown[+hash[1] - 1]) : null;
  if (/\b(that|it|this one|the last one)\b/i.test(text) && lastShown.length === 1) return byId(lastShown[0]);
  return null;
}

/**
 * Short, still-unambiguous product label for a suggestion chip. Two words collided
 * ("Hario V60" named both the dripper and the starter set), and the chip text is fed
 * straight back through resolveProduct, so a collision picked the wrong product.
 */
function shortName(title) {
  return title.replace(/\s*\(.*?\)\s*/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
}

const money = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * One turn of conversation. Pure request/response: all state lives in the session,
 * every money-touching branch goes through checkout.js, never straight to the gateway.
 */
export async function respond({ session_id, text, instrument }) {
  const s = store.session(session_id);
  if (!s) throw new Error('unknown session');
  s.transcript.push({ role: 'user', text, at: Date.now() });

  const { intent, matched } = classify(text);
  const reply = await route({ s, text, intent, instrument });

  ledger.append('agent.turn', {
    actor: s.actor, session_id,
    payload: { intent, rule: matched, utterance: text.slice(0, 200), action_taken: reply.action || 'reply_only' },
  });

  s.transcript.push({ role: 'agent', text: reply.text, at: Date.now() });
  const cart = store.priceCart(session_id);
  return { ...reply, intent, cart, session_state: s.state };
}

async function route({ s, text, intent, instrument }) {
  const cart = store.priceCart(s.id);
  const budget = extractBudget(text);
  const category = extractCategory(text);

  switch (intent) {
    case 'greet':
      return {
        text: `Hi — I am the buying agent for ${MERCHANT.name.replace(/\.$/, '')}. I can find things, explain them, and take payment. Every rupee I move is checked against the merchant's spending policy first, and you can read the audit trail at any point.`,
        chips: ['Show me pour-over gear', 'Beans under ₹800', 'What can you spend?'],
      };

    case 'help':
      return {
        text: `Ask me for products ("beans under ₹800", "show me grinders"), add them ("add two bags of the dark roast"), then say "checkout". I will price the cart, run it past the merchant's policy engine, and only then take payment. Say "audit" to see exactly what I did and why.`,
        chips: ['Show me grinders', 'What can you spend?', 'Audit trail'],
      };

    case 'policy': {
      const p = publicPolicy();
      const m = s.mandate_token ? 'You have handed me a signed mandate, so I am additionally bound by its ceiling, category list and expiry.' : 'No mandate is attached to this session, so I am acting as a human-driven assistant, not an autonomous buyer.';
      return {
        text: `Here is what binds me. I can auto-approve up to ${money(p.per_txn_auto_approve_limit_minor)} per transaction. Anything above that is held for a human to sign off. Above ${money(p.per_txn_hard_cap_minor)} I refuse outright and no approval can override it. Agent spend is capped at ${money(p.agent_daily_cap_minor)} a day, I may never discount more than ${p.max_agent_discount_bps / 100}%, and I am rate limited to ${p.velocity.max_actions} money actions a minute. ${m}`,
        policy: p,
        chips: ['Audit trail', 'Show me the catalog'],
      };
    }

    case 'audit': {
      const rows = ledger.query({ session_id: s.id, limit: 40 });
      return {
        text: rows.length
          ? `${rows.length} entries for this session, hash-chained so none of them can be edited after the fact. Latest first in the panel on the right.`
          : 'Nothing has happened in this session yet, so the trail is empty.',
        audit: rows.slice(-12).reverse(),
        action: 'show_audit',
      };
    }

    case 'view_cart':
      return { text: describeCart(cart), chips: cart.items.length ? ['Checkout', 'Anything else?'] : ['Show me the catalog'] };

    case 'recommend': {
      const q = quote(s.id);
      if (!cart.items.length) {
        const picks = search({ q: 'everyday beans pour-over', limit: 3 });
        s.last_shown = picks.map((p) => p.id);
        return {
          text: `Nothing in the cart yet, so here is where most people start. The Attikan is the one customers re-order without thinking about it.`,
          products: picks, chips: picks.map((p) => `Add ${shortName(p.title)}`),
        };
      }
      if (!q.offers.length) {
        return { text: `Your cart already covers what usually goes together. I have nothing worth adding.`, chips: ['Checkout'] };
      }
      s.last_shown = q.offers.map((o) => o.product_id);
      return {
        text: `Two things worth a look, and here is exactly why I am suggesting them rather than something else:`,
        offers: q.offers, action: 'offer',
        chips: ['Yes, add it', 'No thanks', 'Checkout'],
      };
    }

    case 'search': {
      const results = search({ q: text, category, max_price: budget, limit: 4 });
      if (!results.length) {
        return {
          text: budget
            ? `Nothing under ${money(budget)} matches that. The cheapest thing I have in that direction is ${cheapest(category)}.`
            : `I could not match that to anything in the catalog. I sell coffee, brewing gear and accessories.`,
          chips: ['Show me beans', 'Show me brew gear'],
        };
      }
      s.last_shown = results.map((r) => r.id);
      const qual = [category && `in ${category}`, budget && `under ${money(budget)}`].filter(Boolean).join(' ');
      return {
        text: `${results.length} match${results.length > 1 ? 'es' : ''}${qual ? ' ' + qual : ''}. ${results[0].description}`,
        products: results,
        chips: results.slice(0, 3).map((p) => `Add ${shortName(p.title)}`),
      };
    }

    case 'add': {
      const p = resolveOrdinal(text, s.last_shown) || resolveProduct(text);
      if (!p) {
        return { text: `I could not tell which product you meant. Name it, or say "the first one" after I show you a list.`, chips: ['Show me beans'] };
      }
      if (p.stock <= 0) return { text: `${p.title} is out of stock. I will not put something in your cart I cannot ship.` };
      const qty = extractQty(text);
      const updated = store.addToCart(s.id, p.id, qty);
      s.state = 'cart';
      ledger.append('cart.updated', { actor: s.actor, session_id: s.id, payload: { added: p.id, qty, cart_total_minor: updated.total } });

      const q = quote(s.id);
      const top = q.offers[0];
      s.last_shown = top ? [top.product_id] : s.last_shown;
      return {
        text: `${qty} x ${p.title} added — cart is ${money(updated.total)}.` + (top ? ` ${top.reason}` : '') +
          (updated.amount_to_free_shipping > 0 && updated.amount_to_free_shipping < 50000 ? ` You are ${money(updated.amount_to_free_shipping)} off free delivery.` : ''),
        offers: top ? [top] : [], action: top ? 'offer' : 'cart_update',
        chips: top ? ['Yes, add it', 'No thanks', 'Checkout'] : ['Checkout', 'Anything else?'],
      };
    }

    case 'accept': {
      const q = quote(s.id);
      const target = resolveOrdinal(text, s.last_shown) || (s.last_shown && s.last_shown[0] ? byId(s.last_shown[0]) : null);
      if (!target) return { text: `Happy to — what would you like me to add?`, chips: ['Show me beans'] };
      const offer = q.offers.find((o) => o.product_id === target.id);
      const updated = store.addToCart(s.id, target.id, 1);
      if (offer) s.offers_accepted.push({ product_id: target.id, price_minor: offer.price_minor, type: offer.type });
      ledger.append('offer.accepted', {
        actor: s.actor, session_id: s.id,
        payload: { product_id: target.id, offer_type: offer ? offer.type : 'direct', evidence: offer ? offer.evidence : null, cart_total_minor: updated.total },
      });
      return {
        text: `Added ${target.title}. Cart is ${money(updated.total)}${updated.shipping_minor === 0 ? ', with free delivery' : ''}.`,
        action: 'cart_update', chips: ['Checkout', 'Anything else?'],
      };
    }

    case 'decline':
      return { text: `No problem — I will leave it. Ready to check out when you are.`, chips: ['Checkout', 'Show me something else'] };

    case 'remove': {
      const p = resolveOrdinal(text, s.last_shown) || resolveProduct(text, cart.items.map((i) => byId(i.product_id)));
      if (!p) return { text: `Which one should come out?`, chips: ['View cart'] };
      const updated = store.removeFromCart(s.id, p.id);
      ledger.append('cart.updated', { actor: s.actor, session_id: s.id, payload: { removed: p.id, cart_total_minor: updated.total } });
      return { text: `Removed ${p.title}. Cart is ${money(updated.total)}.`, action: 'cart_update' };
    }

    case 'checkout': {
      if (!cart.items.length) return { text: `Your cart is empty — nothing to pay for yet.`, chips: ['Show me beans'] };
      const key = id('idem');
      const res = await checkout({
        session_id: s.id,
        instrument: instrument || 'card_success',
        idempotency_key: key,
        actor: s.actor,
      });
      return { ...renderCheckout(res, cart), action: 'checkout', checkout: res, idempotency_key: key };
    }

    default:
      return {
        text: `I did not catch that. I can search the catalog, add things to your cart, explain what I am allowed to spend, or take payment.`,
        chips: ['Show me beans', 'What can you spend?', 'View cart'],
      };
  }
}

function renderCheckout(res, cart) {
  if (res.status === 'paid') {
    return { text: `Done — ${money(res.amount_minor)} captured against order ${res.order_id}. The full trail is in the audit panel: policy verdict, gateway calls, and the capture, each one hash-chained.`, chips: ['Audit trail'] };
  }
  if (res.status === 'pending_approval') {
    return { text: `I have stopped short of charging. ${res.decision.summary} Nothing has moved — order is held under approval ${res.approval_id} until a human at the merchant signs it off.`, chips: ['Audit trail'] };
  }
  if (res.status === 'denied') {
    return { text: `I will not put this through. ${res.message} Nothing was reserved and nothing was charged.`, chips: ['View cart'] };
  }
  if (res.status === 'failed') {
    const alts = res.recovery.alternatives.map((a) => a.label).join(' or ');
    return {
      text: `The payment did not go through: ${res.error.description} Your cart is untouched and the stock I was holding has been released, so nobody else lost it either. ${res.recovery.advice} I can retry with ${alts}.`,
      chips: ['Retry with UPI', 'Audit trail'],
      recovery: res.recovery,
    };
  }
  return { text: res.message || 'Something unexpected happened; nothing was charged.' };
}

function describeCart(cart) {
  if (!cart.items.length) return `Your cart is empty.`;
  const lines = cart.items.map((i) => `${i.qty} x ${i.title} — ${money(i.line_total)}`).join('; ');
  const ship = cart.shipping_minor === 0 ? 'free delivery' : `${money(cart.shipping_minor)} delivery`;
  const disc = cart.discount_minor ? `, less ${money(cart.discount_minor)} (${cart.discount_reason})` : '';
  return `${lines}. Subtotal ${money(cart.subtotal)}${disc}, ${ship}. Total ${money(cart.total)}.`;
}

function cheapest(category) {
  const list = PRODUCTS.filter((p) => !category || p.category === category).sort((a, b) => a.price - b.price);
  return list.length ? `${list[0].title} at ${money(list[0].price)}` : 'nothing at all';
}

export const TEST_INSTRUMENTS = INSTRUMENTS;
