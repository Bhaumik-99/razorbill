/**
 * Integration check for every endpoint the web UI depends on.
 * Asserts the exact field names the frontend reads, so a rename breaks this loudly.
 *
 *   node scripts/test-ui-api.js      (server must be running)
 */

const BASE = process.env.BASE || 'http://localhost:3000';
let pass = 0, fail = 0;

const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) });

async function main() {
  section('discovery + policy');
  const man = await api('/.well-known/agent-commerce.json');
  ok(man.status === 200 && man.json.endpoints?.mcp, 'agent-commerce manifest');

  const pol = await api('/api/policy');
  ok(pol.json.policy?.per_txn_auto_approve_limit_minor === 500000, 'policy limits');
  ok(pol.json.mode_label && typeof pol.json.mode_label === 'string', 'mode_label present (UI reads it)');
  ok(Object.keys(pol.json.instruments || {}).length >= 4, 'instrument list for the dropdown');

  section('catalog');
  const cat = await api('/api/catalog');
  const p0 = cat.json.products?.[0];
  ok(Array.isArray(cat.json.products) && cat.json.products.length === 16, 'catalog returns 16 products');
  ok(p0?.price?.amount_minor > 0, 'product.price.amount_minor (UI reads it)');
  ok(typeof p0?.glyph === 'string', 'product.glyph');
  ok(typeof p0?.description === 'string', 'product.description');
  ok(p0?.availability === 'in_stock', 'product.availability');

  section('session + cart');
  const ses = await post('/api/session', { actor: { type: 'human', id: 'test_ui' } });
  const sid = ses.json.session_id;
  ok(!!sid, 'session created');

  const add = await post('/api/cart', { session_id: sid, product_id: 'bb-v60', qty: 1 });
  const line = add.json.cart?.items?.[0];
  ok(line?.unit_price === 129900, 'cart item.unit_price (UI reads it)');
  ok(line?.line_total === 129900, 'cart item.line_total (UI reads it)');
  ok(typeof line?.product_id === 'string', 'cart item.product_id (remove button)');
  ok(add.json.cart?.total > 0, 'cart total');

  const q = await api(`/api/quote?session_id=${sid}`);
  const off = q.json.offers?.[0];
  ok(Array.isArray(q.json.offers) && q.json.offers.length > 0, 'quote returns offers');
  ok(typeof off?.headline === 'string' && typeof off?.reason === 'string', 'offer headline + reason');
  ok(off?.evidence && typeof off.evidence.basis === 'string', 'offer carries evidence');
  ok(typeof off?.price_minor === 'number', 'offer.price_minor');

  section('checkout: decline -> compensation -> recovery');
  const key1 = 'test-' + Date.now();
  const declined = await post('/api/checkout', { session_id: sid, instrument: 'card_insufficient_funds', idempotency_key: key1 });
  ok(declined.json.status === 'failed', 'declined card returns status=failed');
  ok(declined.json.recovery?.stock_released === true, 'inventory released (compensating txn)');
  ok(declined.json.recovery?.cart_preserved === true, 'cart preserved');
  ok(Array.isArray(declined.json.recovery?.alternatives) && declined.json.recovery.alternatives.length > 0, 'alternatives offered');
  ok(typeof declined.json.error?.description === 'string', 'error.description (UI reads it)');

  const replay = await post('/api/checkout', { session_id: sid, instrument: 'card_insufficient_funds', idempotency_key: key1 });
  ok(replay.json.replayed === true, 'same idempotency key replays, no second charge');

  const paid = await post('/api/checkout', { session_id: sid, instrument: 'upi_success', idempotency_key: 'test-' + Date.now() + '-b' });
  ok(paid.json.status === 'paid', 'UPI recovery succeeds');
  ok(typeof paid.json.order_id === 'string' && typeof paid.json.payment_id === 'string', 'order + payment ids');
  ok(paid.json.decision?.verdict === 'allow', 'decision.verdict (UI reads it)');
  ok(Array.isArray(paid.json.decision?.trace) && paid.json.decision.trace.length === 17, 'decision.trace has all 17 rules');
  ok(typeof paid.json.decision.trace[0].id === 'string' && typeof paid.json.decision.trace[0].reason === 'string', 'trace rows have id + reason');

  section('checkout: human approval gate');
  const s2 = (await post('/api/session', { actor: { type: 'human', id: 'test_ui' } })).json.session_id;
  await post('/api/cart', { session_id: s2, product_id: 'bb-grinder-elec', qty: 1 });   // INR 18,999
  const held = await post('/api/checkout', { session_id: s2, instrument: 'card_success', idempotency_key: 'test-hold-' + Date.now() });
  ok(held.json.status === 'pending_approval', 'over auto-approve limit -> pending_approval');
  ok(typeof held.json.approval_id === 'string', 'approval_id returned');

  const apr = await api('/api/approvals');
  const a0 = apr.json.pending?.find((a) => a.id === held.json.approval_id);
  ok(!!a0, 'approval appears in /api/approvals');
  ok(typeof a0?.id === 'string', 'approval.id (UI reads it, not approval_id)');
  ok(typeof a0?.decision?.summary === 'string', 'approval.decision.summary (UI reads it)');
  ok(a0?.actor?.type === 'human', 'approval.actor');
  ok(typeof a0?.amount_minor === 'number', 'approval.amount_minor');

  const approved = await post(`/api/approvals/${held.json.approval_id}`, { approve: true, approver: 'merchant:owner' });
  ok(approved.json.status === 'paid', 'approving captures the payment');

  const bogus = await post('/api/approvals/apr_doesnotexist', { approve: true });
  ok(bogus.status === 404, 'unknown approval id returns 404, not a 500');

  section('checkout: hard cap refusal');
  const s3 = (await post('/api/session', { actor: { type: 'human', id: 'test_ui' } })).json.session_id;
  await post('/api/cart', { session_id: s3, product_id: 'bb-grinder-elec', qty: 2 });   // INR 37,998
  const refused = await post('/api/checkout', { session_id: s3, instrument: 'card_success', idempotency_key: 'test-cap-' + Date.now() });
  ok(refused.json.status === 'denied', 'over hard cap -> denied');
  ok(refused.json.decision?.blocking?.some((b) => b.id === 'merchant.hard_cap'), 'blocked by merchant.hard_cap');

  section('agent chat');
  const s4 = (await post('/api/session', {})).json.session_id;
  const c1 = await post('/api/chat', { session_id: s4, text: 'show me pour over gear under 1500' });
  ok(typeof c1.json.text === 'string' && c1.json.text.length > 0, 'chat returns .text (UI reads it, not .reply)');
  ok(Array.isArray(c1.json.products) && c1.json.products.length > 0, 'chat returns products');
  ok(!!c1.json.cart, 'chat returns cart');

  const c2 = await post('/api/chat', { session_id: s4, text: 'add the first one' });
  ok(c2.json.cart?.items?.length === 1, 'chat added item to cart');
  const c3 = await post('/api/chat', { session_id: s4, text: 'what can you spend?' });
  ok(c3.json.intent === 'policy', 'policy question routes to policy intent');
  const c4 = await post('/api/chat', { session_id: s4, text: 'checkout' });
  ok(!!c4.json.checkout, 'chat checkout returns a checkout result');

  section('growth');
  const lift = await api('/api/lift?sessions=400');
  ok(lift.json.delta?.revenue_pct > 0, 'lift delta.revenue_pct');
  ok(typeof lift.json.control?.aov_minor === 'number', 'control.aov_minor');
  ok(typeof lift.json.caveat === 'string', 'caveat present (honesty about simulation)');

  const aff = await api('/api/affinity?product_id=bb-v60');
  ok(aff.json.partners?.length > 0 && typeof aff.json.partners[0].lift === 'number', 'affinity partners with lift');

  const s5 = (await post('/api/session', {})).json.session_id;
  await post('/api/cart', { session_id: s5, product_id: 'bb-v60', qty: 1 });
  const camp = await api(`/api/campaigns?session_id=${s5}`);
  ok(Array.isArray(camp.json.campaigns), 'campaigns list');

  section('audit + tamper evidence');
  const aud = await api('/api/audit?limit=120');
  ok(aud.json.entries?.length > 0, 'audit entries returned');
  ok(typeof aud.json.head === 'string', 'ledger head hash');
  const withVerdict = aud.json.entries.find((e) => e.decision);
  ok(!!withVerdict?.decision?.verdict, 'entry.decision.verdict (UI reads it, not entry.verdict)');

  const v1 = await api('/api/audit/verify');
  ok(v1.json.ok === true, 'chain verifies before tamper');

  const tam = await post('/api/audit/tamper', { new_amount: 100 });
  ok(typeof tam.json.tampered_seq === 'number', 'tamper endpoint rewrote a row');
  const v2 = await api('/api/audit/verify');
  ok(v2.json.ok === false && v2.json.broken_at === tam.json.tampered_seq, 'chain detects the tamper at the right sequence');
  ok(typeof v2.json.reason === 'string', 'verify explains the break');

  await post('/api/audit/reset', {});
  const v3 = await api('/api/audit/verify');
  ok(v3.json.ok === true, 'chain valid again after reset');

  section('autonomous buyer (server-executed, not canned)');
  const demo = await post('/api/demo/buyer', {});
  ok(Array.isArray(demo.json.steps) && demo.json.steps.length > 8, 'buyer demo returns real steps');
  ok(demo.json.ok === true, 'buyer demo reached a paid state');
  ok(demo.json.chain_ok === true, 'ledger still valid after the demo');
  ok(demo.json.steps.some((s) => /DECLINED/.test(s.text)), 'demo exercised the decline path');
  ok(demo.json.steps.some((s) => /DENIED/.test(s.text)), 'demo exercised the mandate replay refusal');

  section('static assets');
  for (const f of ['/', '/styles.css', '/js/app.js']) {
    const r = await fetch(BASE + f);
    ok(r.ok, `serves ${f}`);
  }
  const missing = await fetch(BASE + '/css/styles.css');
  ok(missing.status === 404, '/css/styles.css is gone (duplicate removed)');

  console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\nharness error:', e.message, '\nIs the server running?\n'); process.exit(1); });
