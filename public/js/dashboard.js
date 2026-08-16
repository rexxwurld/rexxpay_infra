let transactions = [];
let payouts = [];
let customers = [];
let refunds = [];
let disputes = [];
let plans = [];
let subscriptions = [];
let invoices = [];
let txFilter = '';
let txSearch = '';

// The dashboard is a session login (httpOnly cookie), which has no
// key-derived mode - see auth.middleware. Session calls must still tell
// the API which wallet/transaction set to read, so this stays fixed at
// 'live': a logged-in merchant looking at their dashboard wants their
// real numbers, not a hidden toggle they might forget is set to test.
// Test-mode data is still fully reachable via a sk_test_ API key.
const VIEW_MODE = 'live';

function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('Copied to clipboard'),
    () => toast('Could not copy — select and copy manually', true)
  );
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- Sidebar navigation ---------- */
function showTab(name) {
  document.querySelectorAll('.side-link').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}
document.querySelectorAll('.side-link').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
document.querySelectorAll('[data-goto]').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.goto));
});

/* ---------- Profile ---------- */
async function loadProfile() {
  const res = await api('/api/merchant/me');
  document.getElementById('bizName').textContent = res.data.businessName;
  document.getElementById('bizEmail').textContent = res.data.email;
  document.getElementById('webhookUrlInput').value = res.data.webhookUrl || '';

  document.getElementById('setBizName').textContent = res.data.businessName;
  document.getElementById('setBizEmail').textContent = res.data.email;
  document.getElementById('setTestPubKey').textContent = res.data.testPublicKey || '—';
  document.getElementById('setLivePubKey').textContent = res.data.livePublicKey || '—';
}

/* ---------- Wallet ---------- */
async function loadWallet() {
  const res = await api(`/api/wallet?mode=${VIEW_MODE}`);
  document.getElementById('walletBalance').textContent = money(res.data.balance);
}

/* ---------- Transactions ---------- */
function renderTxRow(t) {
  return `
    <tr>
      <td>${esc(t.reference || t.bankReference || '—')}</td>
      <td><span class="status-pill status-${t.status}">${esc(t.status)}</span></td>
      <td>${money(t.amountExpected)}</td>
      <td>${money(t.amountReceived)}</td>
      <td>${fmtDate(t.createdAt)}</td>
    </tr>`;
}

function applyTxFilters() {
  return transactions.filter(t => {
    if (txFilter && t.status !== txFilter) return false;
    if (txSearch) {
      const q = txSearch.toLowerCase();
      const hay = `${t.reference || ''} ${t.bankReference || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTransactions() {
  const filtered = applyTxFilters();
  const tbody = document.querySelector('#txTable tbody');
  const empty = document.getElementById('txEmpty');
  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = filtered.map(renderTxRow).join('');
  }

  // Overview: most recent 5, unfiltered
  const recentBody = document.querySelector('#recentTxTable tbody');
  const recentEmpty = document.getElementById('recentTxEmpty');
  const recent = transactions.slice(0, 5);
  if (!recent.length) {
    recentBody.innerHTML = '';
    recentEmpty.style.display = 'block';
  } else {
    recentEmpty.style.display = 'none';
    recentBody.innerHTML = recent.map(t => `
      <tr>
        <td>${esc(t.reference || t.bankReference || '—')}</td>
        <td><span class="status-pill status-${t.status}">${esc(t.status)}</span></td>
        <td>${money(t.amountReceived)}</td>
        <td>${fmtDate(t.createdAt)}</td>
      </tr>`).join('');
  }
}

function populateRefundTxOptions() {
  const sel = document.getElementById('refTxSelect');
  const refundable = transactions.filter(t => ['success', 'partial', 'over'].includes(t.status));
  sel.innerHTML = '<option value="">Select a refundable transaction…</option>' +
    refundable.map(t => `<option value="${t._id}">${esc(t.reference || t.bankReference || t._id)} — ${money(t.amountReceived)}</option>`).join('');
}

async function loadTransactions() {
  const res = await api(`/api/transactions?mode=${VIEW_MODE}`);
  transactions = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const settled = ['success', 'partial', 'over'];
  const volumeIn = transactions
    .filter(t => settled.includes(t.status))
    .reduce((sum, t) => sum + (t.amountReceived || 0), 0);
  document.getElementById('volumeIn').textContent = money(volumeIn);
  document.getElementById('txCountNote').textContent = `${transactions.length} transaction${transactions.length === 1 ? '' : 's'}`;

  const flagged = transactions.filter(t => t.status === 'flagged').length;
  document.getElementById('flaggedCount').textContent = flagged;

  renderTransactions();
  populateRefundTxOptions();
}

/* ---------- Payouts ---------- */
function renderPayouts() {
  const tbody = document.querySelector('#poTable tbody');
  const empty = document.getElementById('poEmpty');
  if (!payouts.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = payouts.map(p => `
    <tr>
      <td>${esc(p.reference)}</td>
      <td><span class="status-pill status-${p.status}">${esc(p.status)}</span></td>
      <td>${money(p.amount)}</td>
      <td>${esc(p.destinationAccountNumber)} (${esc(p.destinationBankCode)})</td>
      <td>${fmtDate(p.createdAt)}</td>
    </tr>`).join('');
}

async function loadPayouts() {
  const res = await api(`/api/payouts?mode=${VIEW_MODE}`);
  payouts = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const paidOut = payouts
    .filter(p => p.status === 'successful')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  document.getElementById('payoutVolume').textContent = money(paidOut);
  document.getElementById('payoutCountNote').textContent = `${payouts.length} payout${payouts.length === 1 ? '' : 's'}`;

  renderPayouts();
}

/* ---------- Customers ---------- */
function renderCustomers() {
  const tbody = document.querySelector('#custTable tbody');
  const empty = document.getElementById('custEmpty');
  if (!customers.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = customers.map(c => `
      <tr>
        <td>${esc(c.fullName)}</td>
        <td>${esc(c.email)}</td>
        <td>${esc(c.phone || '—')}</td>
        <td>${fmtDate(c.createdAt)}</td>
      </tr>`).join('');
  }

  const sel = document.getElementById('subCustomerSelect');
  sel.innerHTML = '<option value="">Select a customer…</option>' +
    customers.map(c => `<option value="${c._id}">${esc(c.fullName)} — ${esc(c.email)}</option>`).join('');
}

async function loadCustomers() {
  const res = await api('/api/customers');
  customers = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderCustomers();
}

document.getElementById('customerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fullName = document.getElementById('custName').value.trim();
  const email = document.getElementById('custEmail').value.trim();
  const phone = document.getElementById('custPhone').value.trim();
  try {
    await api('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ fullName, email, phone: phone || undefined }),
    });
    toast('Customer added');
    e.target.reset();
    await loadCustomers();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

/* ---------- Refunds ---------- */
function renderRefunds() {
  const tbody = document.querySelector('#refTable tbody');
  const empty = document.getElementById('refEmpty');
  if (!refunds.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = refunds.map(r => `
    <tr>
      <td>${esc(r.reference)}</td>
      <td><span class="status-pill status-${r.status}">${esc(r.status)}</span></td>
      <td>${money(r.amount)}</td>
      <td>${esc(r.reason || '—')}</td>
      <td>${fmtDate(r.createdAt)}</td>
    </tr>`).join('');
}

async function loadRefunds() {
  const res = await api('/api/refunds');
  refunds = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderRefunds();
}

document.getElementById('refundForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const transactionId = document.getElementById('refTxSelect').value;
  const nairaAmount = parseFloat(document.getElementById('refAmount').value);
  const reason = document.getElementById('refReason').value.trim();
  const destinationBankCode = document.getElementById('refBankCode').value.trim();
  const destinationAccountNumber = document.getElementById('refAccountNumber').value.trim();
  const destinationAccountName = document.getElementById('refAccountName').value.trim();

  try {
    await api('/api/refunds', {
      method: 'POST',
      body: JSON.stringify({
        transactionId,
        amount: Math.round(nairaAmount * 100),
        reason: reason || undefined,
        destinationBankCode,
        destinationAccountNumber,
        destinationAccountName,
      }),
    });
    toast('Refund submitted');
    e.target.reset();
    await Promise.all([loadRefunds(), loadWallet()]);
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

/* ---------- Disputes ---------- */
function renderDisputes() {
  const tbody = document.querySelector('#disputeTable tbody');
  const empty = document.getElementById('disputeEmpty');
  const openCount = disputes.filter(d => d.status === 'open' || d.status === 'under_review').length;
  const badge = document.getElementById('disputeBadge');
  if (openCount) {
    badge.textContent = openCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  if (!disputes.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = disputes.map(d => `
      <tr>
        <td>${esc(d.disputeCode)}</td>
        <td><span class="status-pill status-${d.status}">${esc(d.status)}</span></td>
        <td>${money(d.amount)}</td>
        <td>${esc(d.reason)}</td>
        <td>${fmtDate(d.evidenceDueBy)}</td>
        <td>${d.evidence?.length ? `${d.evidence.length} submitted` : '—'}</td>
      </tr>`).join('');
  }

  const sel = document.getElementById('evDisputeSelect');
  const respondable = disputes.filter(d => d.status === 'open' || d.status === 'under_review');
  sel.innerHTML = '<option value="">Select a dispute…</option>' +
    respondable.map(d => `<option value="${d._id}">${esc(d.disputeCode)} — ${money(d.amount)}</option>`).join('');
}

async function loadDisputes() {
  const res = await api('/api/disputes');
  disputes = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderDisputes();
}

document.getElementById('evidenceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const disputeId = document.getElementById('evDisputeSelect').value;
  const description = document.getElementById('evDescription').value.trim();
  const url = document.getElementById('evUrl').value.trim();

  try {
    await api(`/api/disputes/${disputeId}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ description, url: url || undefined }),
    });
    toast('Evidence submitted');
    e.target.reset();
    await loadDisputes();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

/* ---------- Subscriptions: plans, subscriptions, invoices ---------- */
function renderPlans() {
  const tbody = document.querySelector('#planTable tbody');
  const empty = document.getElementById('planEmpty');
  if (!plans.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = plans.map(p => `
      <tr>
        <td>${esc(p.name)}</td>
        <td>${money(p.amount)}</td>
        <td>${esc(p.interval)}</td>
        <td><span class="status-pill status-${p.active ? 'active' : 'cancelled'}">${p.active ? 'active' : 'inactive'}</span></td>
      </tr>`).join('');
  }

  const sel = document.getElementById('subPlanSelect');
  const active = plans.filter(p => p.active);
  sel.innerHTML = '<option value="">Select a plan…</option>' +
    active.map(p => `<option value="${p.planCode}">${esc(p.name)} — ${money(p.amount)}/${esc(p.interval)}</option>`).join('');
}

async function loadPlans() {
  const res = await api('/api/subscriptions/plans');
  plans = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderPlans();
}

document.getElementById('planForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('planName').value.trim();
  const nairaAmount = parseFloat(document.getElementById('planAmount').value);
  const interval = document.getElementById('planInterval').value;

  try {
    await api('/api/subscriptions/plans', {
      method: 'POST',
      body: JSON.stringify({ name, amount: Math.round(nairaAmount * 100), currency: 'NGN', interval }),
    });
    toast('Plan created');
    e.target.reset();
    await loadPlans();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

function renderSubscriptions() {
  const tbody = document.querySelector('#subTable tbody');
  const empty = document.getElementById('subEmpty');
  if (!subscriptions.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = subscriptions.map(s => `
    <tr>
      <td>${esc(s.subscriptionCode)}</td>
      <td>${esc(s.plan?.name || '—')}</td>
      <td><span class="status-pill status-${s.status}">${esc(s.status)}</span></td>
      <td>${fmtDate(s.nextBillingDate)}</td>
      <td>${s.status !== 'cancelled' ? `<button class="btn btn-sm btn-danger-outline" data-cancel-sub="${s._id}">Cancel</button>` : ''}</td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-cancel-sub]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const confirmed = window.confirm('Cancel this subscription? The customer will no longer be billed.');
      if (!confirmed) return;
      try {
        await api(`/api/subscriptions/${btn.dataset.cancelSub}/cancel`, { method: 'POST' });
        toast('Subscription cancelled');
        await loadSubscriptions();
      } catch (err) {
        toast(err.message.replace(/_/g, ' '), true);
      }
    });
  });
}

async function loadSubscriptions() {
  const res = await api('/api/subscriptions');
  subscriptions = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderSubscriptions();
}

document.getElementById('subscribeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customerId = document.getElementById('subCustomerSelect').value;
  const planCode = document.getElementById('subPlanSelect').value;

  try {
    await api('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ customerId, planCode }),
    });
    toast('Customer subscribed');
    e.target.reset();
    await loadSubscriptions();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

function renderInvoices() {
  const tbody = document.querySelector('#invTable tbody');
  const empty = document.getElementById('invEmpty');
  if (!invoices.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = invoices.map(i => `
    <tr>
      <td>${esc(i.invoiceNumber)}</td>
      <td><span class="status-pill status-${i.status}">${esc(i.status)}</span></td>
      <td>${money(i.amount)}</td>
      <td>${fmtDate(i.dueDate)}</td>
    </tr>`).join('');
}

async function loadInvoices() {
  const res = await api('/api/subscriptions/invoices');
  invoices = res.data.sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));
  renderInvoices();
}

/* ---------- Overview / global refresh ---------- */
async function refreshAll() {
  await Promise.all([
    loadProfile(),
    loadWallet(),
    loadTransactions(),
    loadPayouts(),
    loadCustomers(),
    loadRefunds(),
    loadDisputes(),
    loadPlans(),
    loadSubscriptions(),
    loadInvoices(),
  ]);
}

/* ---------- Event wiring: existing panels ---------- */
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/onboarding.html?tab=login';
});

document.getElementById('webhookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const webhookUrl = document.getElementById('webhookUrlInput').value.trim();
  try {
    await api('/api/merchant/webhook-url', { method: 'PATCH', body: JSON.stringify({ webhookUrl }) });
    toast('Webhook URL saved');
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

document.getElementById('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('linkAmount').value);
  const email = document.getElementById('linkEmail').value.trim();
  const name = document.getElementById('linkName').value.trim();

  try {
    const res = await api('/api/payments/initialize', {
      method: 'POST',
      body: JSON.stringify({ amount, customer: { email, name: name || undefined } }),
    });
    document.getElementById('linkResult').innerHTML = `
      <div class="link-card">
        <div class="key-row">
          <div class="k-label">Payment link</div>
          <div class="link-row">
            <div class="k-val" id="genLink">${esc(res.data.link)}</div>
            <button type="button" class="btn btn-sm copy-btn" id="copyLinkBtn">Copy</button>
          </div>
        </div>
        <div class="key-row" style="margin-top:10px;">
          <div class="k-label">Virtual account</div>
          <div class="k-val">${esc(res.data.accountNumber)}</div>
        </div>
      </div>`;
    document.getElementById('copyLinkBtn').addEventListener('click', () => copyToClipboard(res.data.link));
    toast('Payment link generated');
    await Promise.all([loadTransactions(), loadCustomers()]);
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

document.getElementById('payoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nairaAmount = parseFloat(document.getElementById('poAmount').value);
  const destinationBankCode = document.getElementById('poBankCode').value.trim();
  const destinationAccountNumber = document.getElementById('poAccountNumber').value.trim();
  const destinationAccountName = document.getElementById('poAccountName').value.trim();

  try {
    await api('/api/payouts', {
      method: 'POST',
      body: JSON.stringify({
        amount: Math.round(nairaAmount * 100),
        destinationBankCode,
        destinationAccountNumber,
        destinationAccountName,
      }),
    });
    toast('Payout submitted');
    e.target.reset();
    await Promise.all([loadPayouts(), loadWallet()]);
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

function wireRegenButton(btnId, resultId, mode) {
  document.getElementById(btnId).addEventListener('click', async () => {
    const confirmed = window.confirm(
      `Generate a new ${mode} secret key? Your current ${mode} key will stop working ` +
      'immediately — update it anywhere you use it before continuing.'
    );
    if (!confirmed) return;

    try {
      const res = await api('/api/merchant/regenerate-key', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      const resultBox = document.getElementById(resultId);
      const valId = `${resultId}Val`;
      const copyId = `${resultId}Copy`;
      resultBox.innerHTML = `
        <div class="key-reveal">
          <div class="warn">Store this now — it will not be shown again.</div>
          <div class="key-row">
            <div class="k-label">${mode} secret key</div>
            <div class="link-row">
              <div class="k-val" id="${valId}">${esc(res.data.secretKey)}</div>
              <button type="button" class="btn btn-sm copy-btn" id="${copyId}">Copy</button>
            </div>
          </div>
        </div>`;
      document.getElementById(copyId).addEventListener('click', () => copyToClipboard(res.data.secretKey));
      toast(`New ${mode} secret key generated`);
    } catch (err) {
      toast(err.message.replace(/_/g, ' '), true);
    }
  });
}

wireRegenButton('regenTestKeyBtn', 'regenTestKeyResult', 'test');
wireRegenButton('regenLiveKeyBtn', 'regenLiveKeyResult', 'live');

document.querySelectorAll('#txFilters .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#txFilters .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    txFilter = chip.dataset.status;
    renderTransactions();
  });
});

document.getElementById('txSearch').addEventListener('input', (e) => {
  txSearch = e.target.value.trim();
  renderTransactions();
});

refreshAll().catch((err) => {
  if (err.message !== 'unauthenticated') toast(err.message, true);
});
