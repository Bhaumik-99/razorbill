import { search, byId, agentView, MERCHANT, PRODUCTS } from './catalog.js';
import { store } from './store.js';
import { ledger } from './ledger.js';
import { quote, checkout, publicPolicy } from './checkout.js';
import { mintMandate } from './policy.js';
import { razorpay, INSTRUMENTS } from './razorpay.js';

/**
 * Model Context Protocol surface (JSON-RPC 2.0).
 *
 * This is the machine door into the shop. An AI buyer discovers it from
 * /.well-known/agent-commerce.json, lists tools, and transacts -- no HTML, no scraping,
 * no human in the loop unless policy demands one. The tools are intentionally the same
 * code paths the human chat UI uses, so a buyer and a shopper cannot get different
 * treatment from the policy engine.
 */

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'get_merchant_profile',
    description: 'Who this merchant is, what they ship, tax and shipping rules, and the spending policy that binds any agent buying here. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_catalog',
    description: 'Search sellable inventory. Returns machine-readable products with prices in minor units (paise), live availability, and filterable attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query, e.g. "light roast beans"' },
        category: { type: 'string', enum: ['coffee', 'brew-gear', 'accessories', 'subscription'] },
        max_price_minor: { type: 'integer', description: 'Ceiling in paise' },
        min_price_minor: { type: 'integer' },
        limit: { type: 'integer', default: 8, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_product',
    description: 'Full detail for one product by id, including current stock state.',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  },
  {
    name: 'issue_mandate',
    description: 'Mint a signed spending mandate delegating bounded authority to a buying agent: a ceiling, an allowed category list, an item cap and an expiry. Required before an agent may pay. In production the buyer signs this, not the merchant; it is exposed here so the flow is demonstrable end to end.',
    inputSchema: {
      type: 'object',
      properties: {
        buyer_agent: { type: 'string' },
        on_behalf_of: { type: 'string' },
        max_amount_minor: { type: 'integer' },
        allowed_categories: { type: 'array', items: { type: 'string' } },
        max_items: { type: 'integer' },
        ttl_ms: { type: 'integer' },
      },
      required: ['buyer_agent', 'max_amount_minor'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_session',
    description: 'Open a buying session. Attach a mandate token to buy autonomously.',
    inputSchema: {
      type: 'object',
      properties: { mandate_token: { type: 'string' }, agent_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'add_to_cart',
    description: 'Add a product to the session cart. Returns the repriced cart.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, product_id: { type: 'string' }, qty: { type: 'integer', default: 1 } },
      required: ['session_id', 'product_id'], additionalProperties: false,
    },
  },
  {
    name: 'get_quote',
    description: 'Authoritative pricing for the cart (subtotal, discount, shipping, total in paise) plus evidence-backed add-on offers. Never compute the total yourself; this is the only price the merchant will honour.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'], additionalProperties: false },
  },
  {
    name: 'checkout',
    description: 'Attempt payment. Runs the merchant policy engine first. Returns paid | denied | pending_approval | failed, always with the reasoning. Requires an idempotency_key: reusing a key returns the original outcome and never charges twice.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        idempotency_key: { type: 'string' },
        instrument: { type: 'string', enum: Object.keys(INSTRUMENTS), default: 'card_success' },
        mandate_token: { type: 'string' },
      },
      required: ['session_id', 'idempotency_key'], additionalProperties: false,
    },
  },
  {
    name: 'get_order',
    description: 'Order state, payment references and the Razorpay payment link.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'], additionalProperties: false },
  },
  {
    name: 'get_audit_trail',
    description: 'The hash-chained record of every action taken on an order or session, including the policy verdict behind each money movement.',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, session_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false });
const fail = (msg, extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg, ...extra }, null, 2) }], structuredContent: { error: msg, ...extra }, isError: true });

async function call(name, args = {}) {
  switch (name) {
    case 'get_merchant_profile':
      return ok({
        merchant: MERCHANT,
        payment_processor: { name: 'Razorpay', mode: razorpay.mode, note: razorpay.modeLabel },
        spending_policy: publicPolicy(),
        catalog_size: PRODUCTS.length,
        test_instruments: Object.entries(INSTRUMENTS).map(([k, v]) => ({ id: k, method: v.method, expected: v.outcome, label: v.label })),
      });

    case 'search_catalog': {
      const results = search({
        q: args.query || '', category: args.category || null,
        max_price: args.max_price_minor ?? null, min_price: args.min_price_minor ?? null,
        limit: Math.min(args.limit || 8, 20),
      });
      return ok({ count: results.length, currency: 'INR', results });
    }

    case 'get_product': {
      const p = byId(args.product_id);
      return p ? ok(agentView(p)) : fail(`No product with id "${args.product_id}".`);
    }

    case 'issue_mandate': {
      const { mandate, token } = mintMandate(args);
      ledger.append('mandate.issued', {
        actor: { type: 'system', id: 'mandate-authority' },
        payload: { mandate_id: mandate.mandate_id, buyer_agent: mandate.buyer_agent, max_amount_minor: mandate.max_amount_minor,
          allowed_categories: mandate.allowed_categories, expires_at: mandate.expires_at },
      });
      return ok({ mandate, token, note: 'Present this token on checkout. It is single-use unless issued otherwise.' });
    }

    case 'create_session': {
      const agent_id = args.agent_id || 'agent:mcp';
      const s = store.createSession({
        actor: { type: 'agent', id: agent_id },
        mandate_token: args.mandate_token || null,
        channel: 'mcp',
      });
      ledger.append('session.opened', {
        actor: s.actor, session_id: s.id,
        payload: { channel: 'mcp', mandate_attached: Boolean(args.mandate_token) },
      });
      return ok({ session_id: s.id, actor: s.actor, mandate_attached: Boolean(args.mandate_token) });
    }

    case 'add_to_cart': {
      try {
        const cart = store.addToCart(args.session_id, args.product_id, args.qty || 1);
        ledger.append('cart.updated', {
          actor: store.session(args.session_id).actor, session_id: args.session_id,
          payload: { added: args.product_id, qty: args.qty || 1, cart_total_minor: cart.total, via: 'mcp' },
        });
        return ok(cart);
      } catch (e) { return fail(e.message); }
    }

    case 'get_quote': {
      try { return ok(quote(args.session_id)); } catch (e) { return fail(e.message); }
    }

    case 'checkout': {
      try {
        const res = await checkout({
          session_id: args.session_id,
          instrument: args.instrument || 'card_success',
          idempotency_key: args.idempotency_key,
          mandate_token: args.mandate_token,
        });
        return ok(res);
      } catch (e) { return fail(e.message); }
    }

    case 'get_order': {
      const o = store.order(args.order_id);
      return o ? ok(o) : fail(`No order with id "${args.order_id}".`);
    }

    case 'get_audit_trail': {
      if (args.order_id) return ok({ order_id: args.order_id, chain_ok: ledger.verify().ok, entries: ledger.trail(args.order_id) });
      if (args.session_id) return ok({ session_id: args.session_id, chain_ok: ledger.verify().ok, entries: ledger.query({ session_id: args.session_id }) });
      return fail('Supply order_id or session_id.');
    }

    default:
      return fail(`Unknown tool "${name}".`);
  }
}

/** JSON-RPC 2.0 dispatch. */
export async function handleRpc(req) {
  const { id: rid = null, method, params = {} } = req || {};
  const reply = (result) => ({ jsonrpc: '2.0', id: rid, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: rid, error: { code, message } });

  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'razorbill-storefront', version: '1.0.0', vendor: MERCHANT.name },
          instructions: 'Call get_merchant_profile first to learn the spending policy that will be enforced on you. Every checkout requires an idempotency_key, and agent payments require a signed mandate token.',
        });

      case 'notifications/initialized':
        return null;

      case 'tools/list':
        return reply({ tools: TOOLS });

      case 'tools/call': {
        if (!params.name) return error(-32602, 'params.name is required');
        const result = await call(params.name, params.arguments || {});
        return reply(result);
      }

      case 'ping':
        return reply({});

      default:
        return error(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return error(-32603, `Internal error: ${e.message}`);
  }
}

/** The discovery document an AI buyer fetches before it knows anything about this shop. */
export function discoveryManifest(origin) {
  return {
    schema_version: '1.0',
    merchant: { id: MERCHANT.id, name: MERCHANT.name, country: MERCHANT.country, currency: MERCHANT.currency, contact: MERCHANT.support },
    agent_commerce: {
      transactable_by_agents: true,
      requires_mandate: true,
      mandate_scheme: 'HMAC-SHA256 delegated spending mandate (AP2-style: ceiling, category allowlist, item cap, expiry, single-use nonce)',
      idempotency: 'required on every money action',
      human_in_the_loop: 'Transactions above the auto-approve limit are held for merchant approval before any charge.',
      audit: 'Hash-chained append-only ledger; verifiable via GET /api/audit/verify',
    },
    endpoints: {
      mcp: `${origin}/mcp`,
      catalog_feed: `${origin}/api/catalog/feed`,
      merchant_policy: `${origin}/api/policy`,
      audit_verify: `${origin}/api/audit/verify`,
    },
    payments: {
      processor: 'razorpay',
      mode: razorpay.mode,
      methods: ['card', 'upi', 'netbanking', 'wallet'],
      currency: 'INR',
      settlement_country: 'IN',
    },
    protocol_notes: {
      implemented: 'MCP (JSON-RPC 2.0) for tool access; a signed-mandate authorisation model aligned with AP2 intent/cart mandates.',
      interoperability: 'The mandate and policy layer is transport-agnostic. ACP, x402 or a UPI/UAP delegated-payment rail would bind to the same evaluate() gate rather than replacing it.',
    },
    policy: publicPolicy(),
  };
}

export { TOOLS };
