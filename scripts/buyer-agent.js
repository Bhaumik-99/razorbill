/**
 * An external AI buyer. It knows nothing about this merchant at start-up beyond a URL.
 *
 * It discovers the shop, reads the spending policy it will be held to, mints a mandate
 * bounded by its own budget, shops against a goal, evaluates the merchant's offers on
 * its own terms, pays, handles a decline, and finally audits what happened.
 *
 * Run the server first, then:  node scripts/buyer-agent.js
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const BUDGET_MINOR = Number(process.env.BUDGET || 350000);   // this buyer will not spend over INR 3,500
const GOAL = 'light roast beans and something to brew them with';

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

const tool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return r.structuredContent;
};

const inr = (p) => 'INR ' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const say = (who, msg) => console.log(`  ${who.padEnd(7)} ${msg}`);
const rule = (t) => console.log(`\n[1m${t}[0m\n  ${'-'.repeat(Math.max(10, t.length))}`);

async function main() {
  console.log('\n[1mAI BUYER  ->  Razorbill storefront[0m');
  console.log(`  goal:   ${GOAL}`);
  console.log(`  budget: ${inr(BUDGET_MINOR)} (hard, self-imposed)`);

  // 1 -- discovery -----------------------------------------------------------
  rule('1. Discover the merchant');
  const manifest = await (await fetch(`${BASE}/.well-known/agent-commerce.json`)).json();
  say('buyer', `Found ${manifest.merchant.name}. Transactable by agents: ${manifest.agent_commerce.transactable_by_agents}.`);
  say('buyer', `Mandate required: ${manifest.agent_commerce.requires_mandate}. Settling in ${manifest.payments.currency} via ${manifest.payments.processor} (${manifest.payments.mode}).`);

  const init = await rpc('initialize', {});
  const { tools } = await rpc('tools/list', {});
  say('buyer', `MCP ${init.protocolVersion}, ${tools.length} tools available.`);

  // 2 -- read the rules before agreeing to play ------------------------------
  rule('2. Read the policy I will be held to');
  const profile = await tool('get_merchant_profile');
  const pol = profile.spending_policy;
  say('shop', `Auto-approve up to ${inr(pol.per_txn_auto_approve_limit_minor)}; above that a human signs off.`);
  say('shop', `Hard refusal above ${inr(pol.per_txn_hard_cap_minor)}. Idempotency key required on every money action.`);
  say('buyer', `My budget of ${inr(BUDGET_MINOR)} sits under the auto-approve limit, so I expect no human hold.`);

  // 3 -- mandate -------------------------------------------------------------
  rule('3. Mint a mandate bounded by my own budget');
  const { token, mandate } = await tool('issue_mandate', {
    buyer_agent: 'agent:demo-buyer/1.0',
    on_behalf_of: 'cust:ravi',
    max_amount_minor: BUDGET_MINOR,
    allowed_categories: ['coffee', 'brew-gear', 'accessories'],
    max_items: 5,
    ttl_ms: 10 * 60_000,
  });
  say('buyer', `Mandate ${mandate.mandate_id}: ceiling ${inr(mandate.max_amount_minor)}, ${mandate.max_items} items max, expires ${new Date(mandate.expires_at).toLocaleTimeString()}.`);
  say('buyer', 'I have deliberately scoped this below what the merchant would allow. The tighter of the two bounds wins.');

  // 4 -- shop ----------------------------------------------------------------
  rule('4. Shop against the goal');
  const session = await tool('create_session', { mandate_token: token, agent_id: 'agent:demo-buyer' });
  say('buyer', `Session ${session.session_id}.`);

  const beans = await tool('search_catalog', { query: 'light roast beans', category: 'coffee', limit: 3 });
  const pickBeans = beans.results[0];
  say('shop', `${beans.count} matches. Top: ${pickBeans.title} at ${pickBeans.price.display} (${pickBeans.availability}).`);

  const gear = await tool('search_catalog', { query: 'pour over dripper', category: 'brew-gear', max_price_minor: 200000, limit: 3 });
  const pickGear = gear.results[0];
  say('shop', `${gear.count} brew-gear matches under ${inr(200000)}. Top: ${pickGear.title} at ${pickGear.price.display}.`);

  await tool('add_to_cart', { session_id: session.session_id, product_id: pickBeans.id, qty: 1 });
  await tool('add_to_cart', { session_id: session.session_id, product_id: pickGear.id, qty: 1 });
  say('buyer', `Cart: ${pickBeans.title} + ${pickGear.title}.`);

  // 5 -- evaluate the merchant's offers on my terms ---------------------------
  rule('5. Weigh the upsell on my own terms');
  let q = await tool('get_quote', { session_id: session.session_id });
  say('shop', `Quote: subtotal ${inr(q.cart.subtotal)}, shipping ${inr(q.cart.shipping_minor)}, total ${inr(q.cart.total)}.`);

  for (const offer of q.offers) {
    const fits = q.cart.total + offer.price_minor <= BUDGET_MINOR;
    say('shop', `[${offer.type}] ${offer.headline} (+${inr(offer.price_minor)})`);
    say('', `        why: ${offer.reason}`);
    if (offer.type === 'completes' && fits) {
      say('buyer', `Accepting: it is a declared consumable of something I am already buying, and ${inr(q.cart.total + offer.price_minor)} stays inside my ${inr(BUDGET_MINOR)} ceiling.`);
      await tool('add_to_cart', { session_id: session.session_id, product_id: offer.product_id, qty: 1 });
    } else if (!fits) {
      say('buyer', `Declining: would push me to ${inr(q.cart.total + offer.price_minor)}, over my ceiling.`);
    } else {
      say('buyer', `Declining: evidence is real but it is not what I came for.`);
    }
  }

  q = await tool('get_quote', { session_id: session.session_id });
  say('shop', `Final quote: ${inr(q.cart.total)}${q.cart.shipping_minor === 0 ? ' (free shipping earned)' : ''}.`);

  // 6 -- pay, and deal with the decline --------------------------------------
  rule('6. Pay');
  const key1 = 'buyer-' + Date.now() + '-a';
  say('buyer', `Attempting with a card I know is shaky. Idempotency key ${key1}.`);
  let pay = await tool('checkout', {
    session_id: session.session_id, idempotency_key: key1,
    instrument: 'card_insufficient_funds', mandate_token: token,
  });

  if (pay.status === 'failed') {
    say('shop', `DECLINED — ${pay.error.description} (${pay.error.reason}, at ${pay.error.step})`);
    say('shop', `Cart preserved: ${pay.recovery.cart_preserved}. Stock released: ${pay.recovery.stock_released}.`);
    say('shop', `Guidance: ${pay.recovery.retry_same_key}`);

    say('buyer', 'Testing that a naive retry cannot double-charge me: replaying the same key.');
    const replay = await tool('checkout', {
      session_id: session.session_id, idempotency_key: key1,
      instrument: 'card_insufficient_funds', mandate_token: token,
    });
    say('shop', `Replay returned "${replay.status}"${replay.replayed ? ' from the idempotency record — no second gateway call was made' : ''}.`);

    const alt = pay.recovery.alternatives.find((a) => a.method === 'upi') || pay.recovery.alternatives[0];
    const key2 = 'buyer-' + Date.now() + '-b';
    say('buyer', `Switching to ${alt.label} under a fresh key ${key2}.`);
    pay = await tool('checkout', {
      session_id: session.session_id, idempotency_key: key2,
      instrument: alt.instrument, mandate_token: token,
    });
  }

  if (pay.status === 'paid') {
    say('shop', `PAID ${inr(pay.amount_minor)} — order ${pay.order_id}, payment ${pay.payment_id}.`);
    say('shop', `Razorpay order ${pay.razorpay_order_id} (${pay.mode}). Link: ${pay.payment_link}`);
  } else {
    say('shop', `Ended as "${pay.status}": ${pay.message}`);
  }

  // 7 -- mandate replay must now fail ----------------------------------------
  rule('7. Try to spend the burnt mandate again');
  await tool('add_to_cart', { session_id: session.session_id, product_id: pickBeans.id, qty: 1 });
  const replayAttack = await tool('checkout', {
    session_id: session.session_id, idempotency_key: 'buyer-replay-' + Date.now(),
    instrument: 'upi_success', mandate_token: token,
  });
  say('buyer', 'Reusing the single-use mandate token on a brand new cart.');
  say('shop', `${replayAttack.status.toUpperCase()} — ${replayAttack.message}`);

  // 8 -- audit ---------------------------------------------------------------
  rule('8. Audit what just happened');
  const audit = await tool('get_audit_trail', { order_id: pay.order_id });
  say('shop', `Chain valid: ${audit.chain_ok}. ${audit.entries.length} entries on this order.`);
  console.log('');
  for (const e of audit.entries) {
    const amt = e.amount_minor != null ? inr(e.amount_minor).padStart(14) : ''.padStart(14);
    console.log(`   #${String(e.seq).padStart(3)}  ${e.action.padEnd(30)} ${amt}  ${(e.verdict || '').padEnd(6)} ${e.hash}`);
    if (e.because) console.log(`         ${e.because}`);
  }
  console.log('');
}

main().catch((e) => { console.error('\nBuyer agent failed:', e.message, '\nIs the server running?  npm start\n'); process.exit(1); });
