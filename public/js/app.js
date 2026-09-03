/**
 * Razorbill — application controller.
 *
 * Talks to the same REST surface the MCP endpoint sits on, so what you see here is
 * what an AI buyer sees. Money never moves from this file: every charge goes to
 * /api/checkout, which runs the policy engine and writes the ledger before acting.
 */

const state = {
  sessionId: null,
  mandateToken: null,
  products: [],
  cart: null,
  policy: null,
  instruments: {},
  mode: 'SIM',
  chainOk: true,
  auditSeen: 0,
};

// ── helpers ────────────────────────────────────────────────────────────────

function inr(amountMinor) {
  if (amountMinor == null) return '₹0.00';
  return '₹' + (amountMinor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Anything that can contain user text must go through this before innerHTML. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
  el.innerHTML = `<span>${icon}</span> <span>${esc(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4600);
}

async function api(path, options = {}) {
  try {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    console.error(`[api] ${path}`, err);
    toast(err.message, 'error');
    throw err;
  }
}

// ── boot ───────────────────────────────────────────────────────────────────

async function init() {
  setupTabs();
  setupScenarios();
  await createSession();
  await Promise.all([loadCatalog(), loadPolicy(), loadApprovals(), loadAuditTrail(), loadMcpManifest()]);
  await refreshCart();
  initSSE();
  greet();
  loadLift();
  loadCampaigns();
  loadMetrics();
}

/** Tabs switch the right-hand console only; the storefront stays visible throughout. */
function setupTabs() {
  const tabs = document.querySelectorAll('.console-tabs button');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.console-view').forEach((p) => p.classList.remove('active'));
      const target = document.getElementById(tab.getAttribute('data-view'));
      if (target) target.classList.add('active');
    });
  });
}

function showConsole(viewId) {
  const tab = document.querySelector(`.console-tabs button[data-view="${viewId}"]`);
  if (tab) tab.click();
}

/** One-click routes to the states worth watching, so the demo does not depend on luck. */
function setupScenarios() {
  const menu = document.getElementById('demoMenu');
  if (!menu) return;
  menu.addEventListener('change', async () => {
    const choice = menu.value;
    menu.value = '';
    if (!choice) return;

    if (choice === 'decline') {
      await createSession();
      await addToCart('bb-v60');
      await addToCart('bb-beans-attikan');
      const sel = document.getElementById('paymentInstrumentSelect');
      if (sel) sel.value = 'card_insufficient_funds';
      toast('Paying with a card that declines — watch the compensation run', 'info');
      await handleCheckout();
    } else if (choice === 'approval') {
      await createSession();
      await addToCart('bb-grinder-elec');
      toast('₹18,999 is over the auto-approve limit — this will be held', 'info');
      await handleCheckout();
      showConsole('cv-approvals');
    } else if (choice === 'hardcap') {
      await createSession();
      await addToCart('bb-grinder-elec', 2);
      toast('₹37,998 is over the hard cap — this is refused outright', 'info');
      await handleCheckout();
    } else if (choice === 'buyer') {
      showConsole('cv-agent');
      await runBuyerSimulationUI();
    } else if (choice === 'tamper') {
      showConsole('cv-audit');
      await triggerTamper();
    } else if (choice === 'reset') {
      await resetAuditLedger();
      await createSession();
      await refreshCart();
      const chat = document.getElementById('chatMessages');
      if (chat) chat.innerHTML = '';
      greet();
      await loadApprovals();
      await loadMetrics();
    }
  });
}

/** Dock expandables are mutually exclusive: only one panel opens above the composer. */
function togglePanel(panelId, btnId) {
  const panel = document.getElementById(panelId);
  const btn = document.getElementById(btnId);
  if (!panel || !btn) return;
  const open = panel.hasAttribute('hidden');

  for (const [p, b] of [['rail', 'railToggle'], ['cartDrawer', 'cartToggle']]) {
    const pe = document.getElementById(p);
    const be = document.getElementById(b);
    if (pe) pe.setAttribute('hidden', '');
    if (be) be.setAttribute('aria-expanded', 'false');
  }
  if (open) {
    panel.removeAttribute('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }
}

const toggleRail = () => togglePanel('rail', 'railToggle');
const toggleCart = () => togglePanel('cartDrawer', 'cartToggle');

async function loadMetrics() {
  try {
    const m = await api('/api/metrics');
    setText('mRevenue', inr(m.revenue_minor));
    setText('mOrders', m.orders_paid);
  } catch { /* header metrics are decorative; never block on them */ }
}

async function createSession() {
  const data = await api('/api/session', {
    method: 'POST',
    body: JSON.stringify({ actor: { type: 'human', id: 'shopper_ui' } }),
  });
  state.sessionId = data.session_id;
  state.mode = data.mode;
  document.getElementById('sessionIdDisplay').textContent = data.session_id.slice(0, 14) + '…';
  document.getElementById('modeBadge').textContent = `MODE: ${data.mode}`;
}

// ── catalog ────────────────────────────────────────────────────────────────

async function loadCatalog() {
  const data = await api('/api/catalog');
  state.products = data.products;
  renderCatalog(data.products);

  const sel = document.getElementById('affinitySelect');
  if (sel) {
    sel.innerHTML = data.products.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
    loadAffinity();
  }
}

/** Compact horizontal rail above the composer: quick-add without leaving the chat. */
function renderCatalog(products) {
  const rail = document.getElementById('rail');
  if (!rail) return;
  rail.innerHTML = products.map((p) => `
    <button ${p.availability !== 'in_stock' ? 'disabled' : ''} onclick="addToCart('${esc(p.id)}')"
            title="${esc(p.description || '')}">
      <div class="rail-title">${esc(p.title)}</div>
      <div class="rail-price">${inr(p.price.amount_minor)}</div>
      <div style="font-size:10.5px;color:${p.stock_hint === 'limited' ? 'var(--amber)' : 'var(--text-dim)'};">
        ${p.availability === 'in_stock' ? (p.stock_hint === 'limited' ? 'low stock' : 'in stock') : 'out of stock'}
      </div>
    </button>`).join('');
}

// ── cart ───────────────────────────────────────────────────────────────────

async function refreshCart() {
  if (!state.sessionId) return;
  const quote = await api(`/api/quote?session_id=${encodeURIComponent(state.sessionId)}`);
  state.cart = quote.cart;
  renderCart(quote);
}

async function addToCart(productId, qty = 1) {
  if (!state.sessionId) await createSession();
  const quote = await api('/api/cart', {
    method: 'POST',
    body: JSON.stringify({ session_id: state.sessionId, product_id: productId, qty }),
  });
  state.cart = quote.cart;
  renderCart(quote);
  toast('Added to cart', 'success');
}

async function removeFromCart(productId) {
  const quote = await api('/api/cart', {
    method: 'POST',
    body: JSON.stringify({ session_id: state.sessionId, product_id: productId, remove: true }),
  });
  state.cart = quote.cart;
  renderCart(quote);
  toast('Removed', 'info');
}

/** `quote` is the /api/quote shape: { cart, offers, campaigns, policy }. */
function renderCart(quote) {
  const cart = quote.cart;
  const items = cart.items || [];
  const list = document.getElementById('cartList');
  const mirror = document.getElementById('chatCartMirror');

  const linesHtml = items.length === 0
    ? '<div class="empty-state">Your cart is empty.</div>'
    : items.map((item) => `
      <div class="cart-item">
        <div>
          <div style="font-weight:600;">${esc(item.title)}</div>
          <div style="font-size:12px;color:var(--text-muted);">${item.qty} × ${inr(item.unit_price)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-weight:700;color:var(--emerald);">${inr(item.line_total)}</span>
          <button class="btn btn-danger btn-sm" onclick="removeFromCart('${esc(item.product_id)}')">✕</button>
        </div>
      </div>`).join('');

  if (list) list.innerHTML = linesHtml;
  if (mirror) mirror.innerHTML = linesHtml;

  const count = items.reduce((n, i) => n + i.qty, 0);
  setText('cartCount', count);
  setText('cartSubtotal', inr(cart.subtotal));
  setText('cartShipping', cart.shipping_minor === 0 ? 'FREE' : inr(cart.shipping_minor));
  setText('cartTotal', inr(cart.total));
  setText('chatCartTotal', inr(cart.total));

  const badge = document.getElementById('cartCount');
  if (badge) badge.classList.toggle('filled', count > 0);

  const hint = document.getElementById('shipHint');
  if (hint) {
    if (!items.length) hint.textContent = '';
    else if (cart.shipping_minor === 0) hint.innerHTML = '<span class="free">free delivery</span>';
    else hint.textContent = `${inr(cart.shipping_minor)} delivery · ${inr(cart.amount_to_free_shipping)} more for free`;
  }

  renderOffers(quote.offers || []);
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}

/** Offers always carry their evidence: an unexplainable recommendation is not shippable. */
/**
 * How the engine derived an offer, in words a customer can read. The raw values
 * (`market_basket`, `declared_consumable+history`) are internal provenance tokens --
 * they stay in the API response and the audit trail, but never reach the interface.
 */
const BASIS_LABEL = {
  market_basket: 'from order history',
  'declared_consumable+history': 'required accessory',
  declared_tier: 'higher tier of an item in your cart',
  threshold_arithmetic: 'cheaper than the delivery it removes',
};

function offerCardHtml(o) {
  const ev = o.evidence || {};

  // The name line is the product name and nothing else. The offer type is engine
  // metadata; the reason line below already says the relationship in plain language
  // ("Bought together in 71% of ... orders"), so the tag added noise, not meaning.
  const name = (o.product && o.product.title) || o.headline;

  const numbers = [
    ev.lift != null ? `${ev.lift}× lift` : null,
    ev.confidence != null ? `${Math.round(ev.confidence * 100)}% together` : null,
    ev.co_orders != null ? `${ev.co_orders} co-orders` : null,
  ].filter(Boolean);

  const basis = ev.basis ? (BASIS_LABEL[ev.basis] || null) : null;

  return `
    <div class="offer-card" data-offer-type="${esc(o.type)}">
      <div class="offer-header">
        <span class="offer-name">${esc(name)}</span>
        <span class="offer-price">+${inr(o.price_minor)}</span>
      </div>
      <div class="offer-reason">${esc(o.reason)}</div>
      <div class="offer-evidence">
        ${numbers.map((c) => `<span class="ev-num">${esc(c)}</span>`).join('')}
        ${basis ? `<span class="ev-basis">${esc(basis)}</span>` : ''}
      </div>
      <button class="btn btn-primary btn-sm" style="width:100%;" onclick="addToCart('${esc(o.product_id)}')">Add to order</button>
    </div>`;
}

function renderOffers(offers) {
  const section = document.getElementById('offersSection');
  if (!section) return;
  section.innerHTML = offers.length
    ? `<div style="font-size:13px;font-weight:700;margin:14px 0 8px;color:var(--primary);">Recommended add-ons</div>${offers.map(offerCardHtml).join('')}`
    : '';
}

// ── checkout ───────────────────────────────────────────────────────────────

async function handleCheckout() {
  if (!state.sessionId) return;
  const sel = document.getElementById('paymentInstrumentSelect');
  const instrument = sel ? sel.value : 'card_success';

  toast('Running the policy gate…', 'info');

  const res = await api('/api/checkout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: state.sessionId,
      instrument,
      idempotency_key: 'ui-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
      mandate_token: state.mandateToken,
      actor: { type: 'human', id: 'shopper_ui' },
    }),
  });

  renderDecision(res);

  if (res.status === 'paid') {
    toast(`Paid ${inr(res.amount_minor)} · order ${res.order_id}`, 'success');
    await createSession();
    await refreshCart();
  } else if (res.status === 'pending_approval') {
    toast('Held for human approval — nothing charged', 'warning');
    await loadApprovals();
  } else if (res.status === 'denied') {
    toast('Refused by policy — nothing reserved or charged', 'error');
  } else if (res.status === 'failed') {
    toast(`Declined: ${res.error?.description || res.message}`, 'error');
  }

  await loadAuditTrail();
  await loadMetrics();
}

/**
 * The full "why" panel: verdict, summary, and every rule that was evaluated.
 * It renders into the conversation rather than as fixed footer chrome -- a decision is
 * something the agent just did, so it belongs in the transcript next to the request
 * that caused it.
 */
function renderDecision(res) {
  bubble('assistant', decisionHtml(res));
}

function decisionHtml(res) {
  const d = res.decision;
  const cls = res.status === 'failed' ? 'failed' : (d ? d.verdict : 'deny');
  const label = res.status === 'failed' ? 'GATEWAY FAILED' : (d ? d.verdict.toUpperCase() : 'ERROR');
  const summary = res.status === 'failed' ? res.message : (d ? d.summary : res.message);

  let recovery = '';
  if (res.status === 'failed' && res.recovery) {
    recovery = `
      <div class="decision-meta" style="display:block;line-height:1.6;">
        <div>cart preserved: <b style="color:var(--emerald);">${res.recovery.cart_preserved}</b> ·
             stock released: <b style="color:var(--emerald);">${res.recovery.stock_released}</b></div>
        <div style="margin-top:6px;color:var(--text-muted);font-family:var(--font-sans);">${esc(res.recovery.retry_same_key)}</div>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
          ${res.recovery.alternatives.map((a) =>
            `<button class="btn btn-emerald btn-sm" onclick="retryWith('${esc(a.instrument)}')">Retry with ${esc(a.label)}</button>`).join('')}
        </div>
      </div>`;
  }

  const trace = d && d.trace ? `
    <details>
      <summary>${d.rules_passed} of ${d.rules_evaluated} rules passed — show the full evaluation</summary>
      ${d.trace.map((r) => `
        <div class="rule-row ${r.verdict}">
          <span class="rule-dot"></span>
          <span class="rule-id">${esc(r.id)}</span>
          <span class="rule-why">${esc(r.reason)}</span>
        </div>`).join('')}
    </details>` : '';

  return `
    <div class="decision ${cls}">
      <div class="decision-top">
        <span class="verdict-chip">${esc(label)}</span>
        <span class="decision-summary">${esc(summary)}</span>
      </div>
      ${d ? `<div class="decision-meta">
        <span>action: ${esc(d.action)}</span>
        <span>amount: ${inr(d.amount_minor)}</span>
        <span>actor: ${esc(d.actor)}</span>
      </div>` : ''}
      ${recovery}
      ${trace}
    </div>`;
}

/** Recovery after a decline: a NEW idempotency key with a different instrument. */
async function retryWith(instrument) {
  const sel = document.getElementById('paymentInstrumentSelect');
  if (sel) sel.value = instrument;
  await handleCheckout();
}

// ── chat ───────────────────────────────────────────────────────────────────

function greet() {
  bubble('assistant', 'Hi — I am the buying agent for Bluebrew Coffee Co. Ask me for something, add it, then say “checkout”. Every rupee is checked against the merchant policy before it moves, and you can say “audit” to see exactly what I did.');
}

function bubble(role, html) {
  const box = document.getElementById('chatMessages');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `chat-bubble ${role}`;
  el.innerHTML = html;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

async function sendChatMessage(presetText) {
  const input = document.getElementById('chatInput');
  const text = presetText || (input ? input.value.trim() : '');
  if (!text) return;
  if (!presetText && input) input.value = '';

  bubble('user', esc(text));

  let res;
  try {
    res = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ session_id: state.sessionId, text }),
    });
  } catch {
    bubble('assistant', '<span style="color:var(--crimson);">Something went wrong handling that message.</span>');
    return;
  }

  // The agent replies in `text`; products, offers, chips and a decision may ride along.
  let html = esc(res.text);

  if (res.products && res.products.length) {
    html += res.products.map((p) => `
      <div class="cart-item" style="margin-top:8px;">
        <div>
          <div style="font-weight:600;">${esc(p.title)}</div>
          <div style="font-size:12px;color:var(--text-muted);">${esc(p.description || '')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="product-price">${inr(p.price.amount_minor)}</span>
          <button class="btn btn-primary btn-sm" onclick="addToCart('${esc(p.id)}')">Add</button>
        </div>
      </div>`).join('');
  }

  if (res.offers && res.offers.length) {
    html += `<div style="margin-top:10px;">${res.offers.map(offerCardHtml).join('')}</div>`;
  }

  if (res.chips && res.chips.length) {
    html += `<div class="quick-prompts" style="margin-top:10px;">${res.chips
      .map((c) => `<button class="prompt-pill" onclick="sendChatMessage('${esc(c).replace(/'/g, '&#39;')}')">${esc(c)}</button>`)
      .join('')}</div>`;
  }

  bubble('assistant', html);

  if (res.checkout) bubble('assistant', decisionHtml(res.checkout));

  if (res.cart) {
    state.cart = res.cart;
    const quote = await api(`/api/quote?session_id=${encodeURIComponent(state.sessionId)}`);
    renderCart(quote);
  }

  await loadAuditTrail();
  await loadApprovals();
}

// ── policy & approvals ─────────────────────────────────────────────────────

async function loadPolicy() {
  const data = await api('/api/policy');
  state.policy = data.policy;
  state.instruments = data.instruments || {};

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('autoApproveLimit', data.policy.per_txn_auto_approve_limit_minor / 100);
  setVal('hardCapLimit', data.policy.per_txn_hard_cap_minor / 100);
  setVal('dailyCapLimit', data.policy.agent_daily_cap_minor / 100);
  setText('policyModeLabel', data.mode_label);

  const sel = document.getElementById('paymentInstrumentSelect');
  if (sel) {
    sel.innerHTML = Object.entries(state.instruments)
      .map(([k, v]) => `<option value="${esc(k)}">${v.outcome === 'captured' ? '✓' : '✕'} ${esc(v.label)}</option>`)
      .join('');
  }

  const notes = document.getElementById('policyRuleList');
  if (notes) {
    notes.innerHTML = `
      <div class="note-block">
        Agents are additionally rate limited to ${data.policy.velocity.max_actions} money actions per
        ${data.policy.velocity.window_ms / 1000}s and may never discount more than
        ${data.policy.max_agent_discount_bps / 100}%. An idempotency key is mandatory on every
        money action, so a retry can never double-charge.
      </div>`;
  }
}

async function loadApprovals() {
  const data = await api('/api/approvals');
  const container = document.getElementById('approvalsList');
  const badge = document.getElementById('approvalsBadge');
  if (badge) badge.textContent = data.pending.length;

  if (!container) return;
  if (!data.pending.length) {
    container.innerHTML = '<div class="empty-state"><b>Nothing waiting</b>No payment is currently held for a human.</div>';
    return;
  }

  container.innerHTML = data.pending.map((a) => `
    <div class="approval-card">
      <div class="ap-top">
        <div class="ap-amt">${inr(a.amount_minor)}</div>
        <div class="ap-why">${esc(a.decision ? a.decision.summary : 'Held for review.')}</div>
        <div class="ap-meta">${esc(a.id)} · actor ${esc(a.actor.type)}:${esc(a.actor.id)} · session ${esc(String(a.session_id).slice(0, 14))}…</div>
      </div>
      <div class="ap-actions">
        <button class="btn btn-emerald btn-sm" onclick="resolveApproval('${esc(a.id)}', true)">Approve</button>
        <button class="btn btn-danger btn-sm" onclick="resolveApproval('${esc(a.id)}', false)">Reject</button>
      </div>
    </div>`).join('');
}

async function resolveApproval(approvalId, approve) {
  const res = await api(`/api/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    body: JSON.stringify({ approve, approver: 'merchant:owner', note: 'Resolved from the merchant console' }),
  });

  if (res.status === 'paid') toast(`Approved and captured ${inr(res.amount_minor)}`, 'success');
  else if (res.status === 'rejected') toast('Rejected — nothing was charged', 'warning');
  else if (res.status === 'denied') toast(`Still refused: ${res.message}`, 'error');
  else if (res.status === 'failed') toast(`Approved, but the gateway declined: ${res.error?.description}`, 'error');
  else toast(`Approval ${res.status}`, 'info');

  await Promise.all([loadApprovals(), loadAuditTrail(), refreshCart()]);
}

// ── audit ──────────────────────────────────────────────────────────────────

async function loadAuditTrail() {
  const data = await api('/api/audit?limit=120');
  renderAuditTrail(data.entries, data.head);
  updateChainStatus(await api('/api/audit/verify'));
}

function renderAuditTrail(entries, headHash) {
  const container = document.getElementById('auditRows');
  if (!container) return;
  if (headHash) setText('ledgerHeadHash', headHash.slice(0, 16) + '…');

  if (!entries.length) {
    container.innerHTML = '<div class="empty-state"><b>Ledger is empty</b>Add something to the cart and pay to see entries appear.</div>';
    return;
  }

  const broken = state.chainOk ? null : state.brokenAt;

  // Newest first: this is a live feed, and the most recent action is the one you want.
  container.innerHTML = entries.slice().reverse().map((e) => {
    const verdict = e.decision ? e.decision.verdict : '';

    // On a failed row the policy verdict is genuinely "allow" -- policy permitted the
    // attempt and the bank refused it. Showing a green "allow" beside a failure reads as
    // a contradiction, so failures show the gateway reason instead.
    const isErr = e.severity === 'error';
    const vText = isErr ? (e.payload && e.payload.reason ? e.payload.reason : 'failed') : verdict;
    const vColor = isErr ? 'var(--crimson)'
      : verdict === 'allow' ? 'var(--emerald)'
      : verdict === 'review' ? 'var(--amber)'
      : verdict === 'deny' ? 'var(--crimson)' : 'var(--text-dim)';
    const cls = [
      e.severity === 'warn' ? 'sev-warn' : '',
      e.severity === 'error' ? 'sev-error' : '',
      e.amount_minor != null && !e.severity ? 'money' : '',
      broken && e.seq >= broken ? 'broken' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="audit-row ${cls}" title="${esc(e.actor_type)}:${esc(e.actor_id)}">
        <span style="color:var(--text-dim);">#${e.seq}</span>
        <span style="font-weight:600;color:var(--text-main);">${esc(e.action)}</span>
        <span style="color:var(--emerald);">${e.amount_minor != null ? inr(e.amount_minor) : ''}</span>
        <span style="color:${vColor};" title="${esc(vText)}">${esc(vText)}</span>
        <span class="hash-code">${esc(String(e.hash).slice(0, 16))}…</span>
      </div>`;
  }).join('');
}

function updateChainStatus(ver) {
  const wasOk = state.chainOk;
  state.chainOk = ver.ok;
  state.brokenAt = ver.broken_at || null;

  const badge = document.getElementById('chainStatusBadge');
  const dot = document.getElementById('chainStatusDot');
  if (!badge || !dot) return;

  if (ver.ok) {
    badge.textContent = `HASH CHAIN: VALID (${ver.entries})`;
    dot.className = 'status-dot green';
  } else {
    badge.textContent = `CHAIN BROKEN @ #${ver.broken_at}`;
    dot.className = 'status-dot red';
    if (wasOk) toast(`Tamper detected — chain breaks at entry #${ver.broken_at}. ${ver.reason}`, 'error');
  }
}

let sseTimer = null;
function initSSE() {
  try {
    const sse = new EventSource('/api/events');
    sse.addEventListener('ledger', () => {
      // Coalesce bursts: a checkout writes six entries in a few milliseconds.
      clearTimeout(sseTimer);
      sseTimer = setTimeout(loadAuditTrail, 220);
    });
    sse.onerror = () => console.warn('[sse] disconnected; will retry automatically');
  } catch (e) {
    console.error('[sse]', e);
  }
}

async function triggerTamper() {
  try {
    const res = await api('/api/audit/tamper', { method: 'POST', body: JSON.stringify({ new_amount: 100 }) });
    toast(`Entry #${res.tampered_seq} rewritten from ${inr(res.before)} to ${inr(res.after)} without touching its hash`, 'warning');
    await loadAuditTrail();
  } catch { /* api() already surfaced it */ }
}

async function resetAuditLedger() {
  await api('/api/audit/reset', { method: 'POST' });
  state.chainOk = true;
  toast('Ledger reset', 'info');
  await loadAuditTrail();
}

function exportLedger() {
  window.open('/api/audit/export', '_blank');
}

// ── AI buyer ───────────────────────────────────────────────────────────────

async function mintMandateSimulator() {
  const buyerAgent = document.getElementById('mandateBuyerAgent').value || 'agent:sandbox-buyer';
  const budget = Number(document.getElementById('mandateBudget').value || 3500) * 100;

  const data = await api('/api/mandate', {
    method: 'POST',
    body: JSON.stringify({
      buyer_agent: buyerAgent, max_amount_minor: budget,
      allowed_categories: ['coffee', 'brew-gear', 'accessories'], max_items: 5, ttl_ms: 600000,
    }),
  });

  state.mandateToken = data.token;
  setText('mintedTokenDisplay', data.token.slice(0, 34) + '…');
  toast(`Mandate minted with a ${inr(budget)} ceiling`, 'success');
  await loadAuditTrail();
}

/**
 * Runs the buyer flow for real on the server and streams back what actually happened.
 * Nothing here is canned: if the decline path changes, these lines change with it.
 */
async function runBuyerSimulationUI() {
  const term = document.getElementById('buyerSimTerminal');
  term.textContent = 'Launching autonomous buyer against the live server…\n\n';

  try {
    const res = await api('/api/demo/buyer', { method: 'POST', body: JSON.stringify({}) });
    for (const step of res.steps) {
      term.textContent += `${String(step.who).padEnd(6)} ${step.text}\n`;
      term.scrollTop = term.scrollHeight;
      await new Promise((r) => setTimeout(r, 90));
    }
    term.textContent += `\nchain valid: ${res.chain_ok}\n`;
    toast(res.ok ? 'Buyer agent completed the full flow' : 'Buyer agent finished with a failure', res.ok ? 'success' : 'warning');
    await Promise.all([loadAuditTrail(), loadApprovals()]);
  } catch (e) {
    term.textContent += `\nfailed: ${e.message}\n`;
  }
}

async function loadMcpManifest() {
  const data = await api('/.well-known/agent-commerce.json');
  setText('mcpManifestDisplay', JSON.stringify(data, null, 2));
}

// ── growth ─────────────────────────────────────────────────────────────────

async function loadLift() {
  const d = await api('/api/lift?sessions=400');
  const kpis = document.getElementById('liftKpis');
  const bars = document.getElementById('liftBars');
  if (!kpis || !bars) return;

  const tile = (label, value, sub, up) => `
    <div class="stat-card">
      <div>
        <div class="stat-lbl">${esc(label)}</div>
        <div class="stat-val" style="${up ? 'color:var(--emerald);' : ''}">${esc(value)}</div>
        <div style="font-size:11.5px;color:var(--text-dim);">${esc(sub)}</div>
      </div>
    </div>`;

  kpis.innerHTML = [
    tile('Revenue lift', `+${d.delta.revenue_pct}%`, `${inr(d.delta.incremental_revenue_minor)} incremental`, true),
    tile('Margin lift', `+${d.delta.margin_pct}%`, `${inr(d.delta.incremental_margin_minor)} incremental`, true),
    tile('AOV lift', `+${d.delta.aov_pct}%`, `${inr(d.control.aov_minor)} → ${inr(d.treatment.aov_minor)}`, true),
  ].join('');

  const row = (label, ctrl, trt, fmt) => {
    const max = Math.max(ctrl, trt) || 1;
    return `
      <div class="bar-row">
        <div class="bar-label"><span>${esc(label)}</span><b>${fmt(ctrl)} → ${fmt(trt)}</b></div>
        <div class="bar-track"><i class="bar-fill control" style="width:${(ctrl / max) * 100}%"></i></div>
        <div class="bar-track" style="margin-top:4px;"><i class="bar-fill treatment" style="width:${(trt / max) * 100}%"></i></div>
      </div>`;
  };

  bars.innerHTML = `
    <div class="bar-legend">
      <span><i style="background:#3d4557;"></i>control — agent off</span>
      <span><i style="background:var(--primary);"></i>treatment — agent on</span>
    </div>
    ${row('Revenue', d.control.revenue_minor, d.treatment.revenue_minor, inr)}
    ${row('Gross margin', d.control.margin_minor, d.treatment.margin_minor, inr)}
    ${row('Average order value', d.control.aov_minor, d.treatment.aov_minor, inr)}
    ${row('Orders converted', d.control.orders, d.treatment.orders, (n) => n + ' orders')}`;

  setText('liftCaveat', d.caveat);
}

async function loadAffinity() {
  const sel = document.getElementById('affinitySelect');
  const host = document.getElementById('affinityTable');
  if (!sel || !host || !sel.value) return;

  const d = await api(`/api/affinity?product_id=${encodeURIComponent(sel.value)}`);
  const name = (id) => (state.products.find((p) => p.id === id) || {}).title || id;

  host.innerHTML = d.partners.length ? `
    <table class="affinity">
      <thead><tr><th>Also bought</th><th style="text-align:right;">Lift</th><th style="text-align:right;">Together</th><th style="text-align:right;">Orders</th></tr></thead>
      <tbody>${d.partners.map((p) => `
        <tr>
          <td>${esc(name(p.product_id))}</td>
          <td class="n lift">${p.lift.toFixed(2)}×</td>
          <td class="n">${Math.round(p.confidence * 100)}%</td>
          <td class="n">${p.co_orders}</td>
        </tr>`).join('')}</tbody>
    </table>`
    : '<div class="empty-state">No co-purchase pattern clears the lift threshold for this product.</div>';
}

async function loadCampaigns() {
  const host = document.getElementById('campaignsList');
  if (!host || !state.sessionId) return;

  const d = await api(`/api/campaigns?session_id=${encodeURIComponent(state.sessionId)}`);
  host.innerHTML = d.campaigns.length ? d.campaigns.map((c) => `
    <div class="campaign-card">
      <div class="cc-title">${esc(c.title)}</div>
      <div class="cc-trigger">Trigger: ${esc(c.trigger)}</div>
      <div class="cc-msg">${esc(c.message)}</div>
      <div class="cc-foot">
        <span class="cap-chip">capped at ${c.max_discount_bps / 100}%</span>
        ${c.discount_bps ? `<button class="btn btn-secondary btn-sm" onclick="applyCampaign('${esc(c.campaign_id)}')">Apply incentive</button>` : '<span style="font-size:12px;color:var(--text-dim);">nudge only — spends no margin</span>'}
      </div>
    </div>`).join('')
    : '<div class="empty-state"><b>No campaign matches</b>Add items to the cart, then leave it idle to trigger recovery.</div>';
}

async function applyCampaign(campaignId) {
  const res = await api('/api/campaigns/apply', {
    method: 'POST',
    body: JSON.stringify({ session_id: state.sessionId, campaign_id: campaignId }),
  });
  if (res.status === 'applied') toast(`Incentive applied: ${inr(res.discount_minor)} off`, 'success');
  else if (res.status === 'blocked') toast(`Policy blocked the discount: ${res.message}`, 'error');
  else toast(res.message || res.status, 'info');
  await Promise.all([refreshCart(), loadAuditTrail()]);
}

// ── exports for inline handlers ────────────────────────────────────────────

Object.assign(window, {
  addToCart, removeFromCart, handleCheckout, retryWith, sendChatMessage,
  resolveApproval, triggerTamper, resetAuditLedger, exportLedger,
  mintMandateSimulator, runBuyerSimulationUI, loadLift, loadAffinity, applyCampaign,
  toggleRail, toggleCart, showConsole, loadMetrics,
});

document.addEventListener('DOMContentLoaded', init);
