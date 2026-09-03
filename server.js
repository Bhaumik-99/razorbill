import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MERCHANT, PRODUCTS, agentView, search } from './src/catalog.js';
import { store } from './src/store.js';
import { ledger } from './src/ledger.js';
import { razorpay, INSTRUMENTS } from './src/razorpay.js';
import { mintMandate } from './src/policy.js';
import { quote, checkout, resolveApproval, refundOrder, applyCampaignIncentive, publicPolicy } from './src/checkout.js';
import { respond } from './src/agent.js';
import { simulateLift, matchCampaigns, affinity } from './src/growth.js';
import { handleRpc, discoveryManifest } from './src/mcp.js';
import { runBuyerDemo } from './src/demo.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', ...headers });
  res.end(payload);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** Everything a machine buyer needs about the whole catalog in one document. */
function catalogFeed(origin) {
  return {
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    merchant: { id: MERCHANT.id, name: MERCHANT.name, currency: MERCHANT.currency, ships_to: MERCHANT.fulfilment.ships_to },
    shipping: { free_over_minor: MERCHANT.fulfilment.free_shipping_threshold, flat_minor: MERCHANT.fulfilment.flat_shipping },
    tax: MERCHANT.tax,
    transact_via: `${origin}/mcp`,
    count: PRODUCTS.length,
    products: PRODUCTS.map(agentView),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:' + PORT}`);
  const origin = `http://${req.headers.host || 'localhost:' + PORT}`;
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    // -- agent discovery -------------------------------------------------
    if (p === '/.well-known/agent-commerce.json') return send(res, 200, discoveryManifest(origin));

    if (p === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON-RPC 2.0 to this endpoint' });
      const body = await readBody(req);
      const out = Array.isArray(body)
        ? (await Promise.all(body.map(handleRpc))).filter(Boolean)
        : await handleRpc(body);
      if (out === null) return send(res, 202, '');
      return send(res, 200, out);
    }

    // -- catalog ---------------------------------------------------------
    if (p === '/api/catalog/feed') return send(res, 200, catalogFeed(origin));
    if (p === '/api/catalog/search') {
      return send(res, 200, {
        results: search({
          q: q.get('q') || '', category: q.get('category'),
          max_price: q.get('max_price') ? +q.get('max_price') : null,
          limit: +(q.get('limit') || 8),
        }),
      });
    }
    if (p === '/api/catalog') return send(res, 200, { products: PRODUCTS.map((x) => ({ ...agentView(x), glyph: x.glyph, margin_bps: x.margin_bps })) });

    // -- policy & mandates -----------------------------------------------
    if (p === '/api/policy') return send(res, 200, { policy: publicPolicy(), mode: razorpay.mode, mode_label: razorpay.modeLabel, instruments: INSTRUMENTS });

    if (p === '/api/mandate' && req.method === 'POST') {
      const body = await readBody(req);
      const { mandate, token } = mintMandate(body);
      ledger.append('mandate.issued', {
        actor: { type: 'system', id: 'mandate-authority' },
        payload: { mandate_id: mandate.mandate_id, buyer_agent: mandate.buyer_agent, max_amount_minor: mandate.max_amount_minor, expires_at: mandate.expires_at },
      });
      return send(res, 200, { mandate, token });
    }

    // -- sessions & chat --------------------------------------------------
    if (p === '/api/session' && req.method === 'POST') {
      const body = await readBody(req);
      const s = store.createSession({
        actor: body.actor || { type: 'human', id: 'shopper' },
        mandate_token: body.mandate_token || null,
        channel: body.channel || 'chat',
      });
      ledger.append('session.opened', { actor: s.actor, session_id: s.id, payload: { channel: s.channel, mandate_attached: Boolean(s.mandate_token) } });
      return send(res, 200, { session_id: s.id, actor: s.actor, cart: store.priceCart(s.id), policy: publicPolicy(), mode: razorpay.mode });
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!store.session(body.session_id)) return send(res, 404, { error: 'unknown session' });
      return send(res, 200, await respond({ session_id: body.session_id, text: String(body.text || ''), instrument: body.instrument }));
    }

    if (p === '/api/quote') {
      try { return send(res, 200, quote(q.get('session_id'))); }
      catch (e) { return send(res, 404, { error: e.message }); }
    }

    if (p === '/api/cart' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const cart = b.remove ? store.removeFromCart(b.session_id, b.product_id) : store.addToCart(b.session_id, b.product_id, b.qty || 1);
        return send(res, 200, quote(b.session_id));
      } catch (e) {
        return send(res, 404, { error: e.message });
      }
    }

    // -- money ------------------------------------------------------------
    if (p === '/api/checkout' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        return send(res, 200, await checkout({
          session_id: b.session_id, instrument: b.instrument, idempotency_key: b.idempotency_key,
          mandate_token: b.mandate_token, actor: b.actor,
        }));
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    if (p === '/api/refund' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, await refundOrder(b));
    }

    if (p === '/api/approvals') return send(res, 200, { pending: store.pendingApprovals() });

    if (p.startsWith('/api/approvals/') && req.method === 'POST') {
      const b = await readBody(req);
      const approval_id = p.split('/').pop();
      try {
        return send(res, 200, await resolveApproval({ approval_id, approve: b.approve !== false, note: b.note || '', approver: b.approver || 'merchant:owner' }));
      } catch (e) {
        return send(res, 404, { error: e.message });
      }
    }

    // -- growth -------------------------------------------------------------
    if (p === '/api/campaigns') {
      const sid = q.get('session_id');
      const s = store.session(sid);
      if (!s) return send(res, 404, { error: 'unknown session' });
      return send(res, 200, { campaigns: matchCampaigns(s, store.priceCart(sid)) });
    }

    if (p === '/api/campaigns/apply' && req.method === 'POST') {
      const b = await readBody(req);
      const s = store.session(b.session_id);
      if (!s) return send(res, 404, { error: 'unknown session' });
      return send(res, 200, applyCampaignIncentive(b.session_id, b.campaign_id, b.actor || s.actor));
    }

    if (p === '/api/lift') return send(res, 200, simulateLift({ sessions: +(q.get('sessions') || 400) }));

    // Runs the autonomous buyer flow for real and returns what actually happened.
    if (p === '/api/demo/buyer' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, await runBuyerDemo({ budget_minor: b.budget_minor || 350000 }));
    }

    if (p === '/api/affinity') {
      const pid = q.get('product_id');
      return send(res, 200, { product_id: pid, partners: affinity.partners(pid).slice(0, 6) });
    }

    if (p === '/api/metrics') return send(res, 200, { ...store.metrics(), mode: razorpay.mode, chain: ledger.verify() });

    // -- audit ---------------------------------------------------------------
    if (p === '/api/audit') {
      return send(res, 200, {
        entries: ledger.query({
          session_id: q.get('session_id') || undefined,
          order_id: q.get('order_id') || undefined,
          action: q.get('action') || undefined,
          since_seq: +(q.get('since_seq') || 0),
          limit: +(q.get('limit') || 100),
        }),
        head: ledger.head,
      });
    }

    if (p === '/api/audit/verify') return send(res, 200, ledger.verify());

    if (p === '/api/audit/export') {
      return send(res, 200, ledger.entries, { 'Content-Disposition': 'attachment; filename="razorbill-audit.json"' });
    }

    /**
     * Demonstrates tamper-evidence: silently rewrite an amount in a historical entry,
     * exactly as a bad actor with database access would, then let /api/audit/verify
     * catch it. Guarded so it cannot be reached outside the local demo.
     */
    if (p === '/api/audit/tamper' && req.method === 'POST') {
      const b = await readBody(req);
      const target = ledger.entries.find((e) => e.amount_minor != null && e.action === 'payment.captured');
      if (!target) return send(res, 400, { error: 'No captured payment in the ledger yet. Complete a purchase first.' });
      const before = target.amount_minor;
      target.amount_minor = b.new_amount ?? 100;
      ledger.persist();
      return send(res, 200, {
        tampered_seq: target.seq, field: 'amount_minor', before, after: target.amount_minor,
        verify: ledger.verify(),
        note: 'The row was edited in place without touching its stored hash, which is what an attacker with write access would do. Verification now fails at that sequence number and every hash after it is invalidated.',
      });
    }

    if (p === '/api/audit/reset' && req.method === 'POST') { ledger.reset(); return send(res, 200, { ok: true }); }

    // -- live ledger stream ---------------------------------------------------
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: hello\ndata: ${JSON.stringify({ head: ledger.head, entries: ledger.entries.length })}\n\n`);
      const unsub = ledger.subscribe((e) => {
        try { res.write(`event: ledger\ndata: ${JSON.stringify(e)}\n\n`); } catch { /* client vanished */ }
      });
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25_000);
      req.on('close', () => { unsub(); clearInterval(beat); });
      return;
    }

    // -- simulated hosted checkout (SIM mode payment links) --------------------
    if (p.startsWith('/sim/checkout/')) {
      return send(res, 200, simCheckoutPage(p.split('/').pop()), { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // -- static ----------------------------------------------------------------
    const file = p === '/' ? '/index.html' : p;
    const full = path.join(ROOT, 'public', path.normalize(file).replace(/^([.][.][/\\])+/, ''));
    if (full.startsWith(path.join(ROOT, 'public')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      return send(res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    }

    return send(res, 404, { error: `No route for ${req.method} ${p}` });
  } catch (e) {
    console.error('[server]', e);
    return send(res, 500, { error: e.message });
  }
});

function simCheckoutPage(plink) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Razorpay test checkout (simulated)</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui;background:#0b0d10;color:#e6e8eb;display:grid;place-items:center;height:100vh;margin:0}
.c{max-width:420px;padding:32px;border:1px solid #23272e;border-radius:14px;background:#12151a}
code{background:#1a1e24;padding:2px 6px;border-radius:4px;color:#7dd3a0}</style></head>
<body><div class="c"><h2>Simulated hosted checkout</h2>
<p>Payment link <code>${plink}</code>.</p>
<p>No Razorpay keys are configured, so this stands in for the hosted test-mode checkout page.
Set <code>RAZORPAY_KEY_ID</code> and <code>RAZORPAY_KEY_SECRET</code> and this becomes a real
Razorpay test-mode link instead.</p>
<p>Authorisation in this demo is driven from the agent by choosing a test instrument, so the
success and failure paths are both reproducible.</p></div></body></html>`;
}

server.listen(PORT, () => {
  console.log('');
  console.log('  Razorbill — agentic commerce rail for ' + MERCHANT.name);
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  storefront + console  http://localhost:${PORT}`);
  console.log(`  agent discovery       http://localhost:${PORT}/.well-known/agent-commerce.json`);
  console.log(`  MCP endpoint          POST http://localhost:${PORT}/mcp`);
  console.log(`  payments              ${razorpay.modeLabel}`);
  console.log(`  ledger                ${ledger.entries.length} entries, chain ${ledger.verify().ok ? 'valid' : 'BROKEN'}`);
  console.log('');
});

export default server;
