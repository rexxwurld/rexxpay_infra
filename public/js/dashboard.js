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

// Sets textContent by id, silently no-oping if that id isn't on the
// current page — safer than a bare getElementById().textContent chain
// when a panel gets moved/renamed between tabs.
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ---------- Sidebar navigation ---------- */
function showTab(name) {
  document.querySelectorAll('.side-link').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  // Chart.js can't size a canvas that was hidden (display:none) at creation time,
  // so re-render whenever a chart-bearing tab becomes visible.
  // Analytics charts now live inside the Settings tab (see dashboard.html).
  if (name === 'overview' || name === 'settings') {
    requestAnimationFrame(() => renderCharts());
  }
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

  const firstName = (res.data.businessName || '').trim().split(/\s+/)[0] || 'there';
  setText('pageGreetName', firstName);
  setText('sideBizName', res.data.businessName);
  setText('sideMerchantId', res.data._id ? `Merchant ID: ${res.data._id}` : '');
  const initial = (res.data.businessName || '?').trim().charAt(0).toUpperCase();
  setText('sideAvatarInitial', initial || '?');
}

/* ---------- Wallet ---------- */
let walletBalanceMinor = null;
let balanceRevealed = false;

function renderBalanceCard() {
  const masked = '₦ ******';
  setText('balNGN', balanceRevealed ? money(walletBalanceMinor) : masked);
  setText('balDetailNGN', walletBalanceMinor === null ? '—' : money(walletBalanceMinor));
}

async function loadWallet() {
  const res = await api(`/api/wallet?mode=${VIEW_MODE}`);
  walletBalanceMinor = res.data.balance;
  renderBalanceCard();
}

document.getElementById('balNGNEye')?.addEventListener('click', () => {
  balanceRevealed = !balanceRevealed;
  renderBalanceCard();
});

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
  setText('ovTotalValue', money(volumeIn));
  setText('ovTotalValue2', money(volumeIn));
  setText('ovTotalVolume', String(transactions.length));

  const flagged = transactions.filter(t => t.status === 'flagged').length;
  setText('flaggedCount', String(flagged));

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
  setText('ovTotalSettlements', money(paidOut));
  setText('ovTotalSettlements2', money(paidOut));
  setText('payoutCountNote', `${payouts.length} payout${payouts.length === 1 ? '' : 's'}`);

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

/* ---------- Subaccounts ---------- */
let subaccounts = [];

function renderSubaccounts() {
  const tbody = document.querySelector('#subaccTable tbody');
  const empty = document.getElementById('subaccEmpty');
  if (!subaccounts.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = subaccounts.map(s => `
    <tr>
      <td>${esc(s.businessName)}</td>
      <td>${esc(s.settlementAccountNumber)} (${esc(s.settlementBankCode)})</td>
      <td>${s.defaultSplitPercentage != null ? s.defaultSplitPercentage + '%' : '—'}</td>
      <td>${fmtDate(s.createdAt)}</td>
      <td><button class="btn btn-sm" data-settle-subacc="${s._id}">Settle</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-settle-subacc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/subaccounts/${btn.dataset.settleSubacc}/settle`, { method: 'POST' });
        toast('Subaccount settled');
        await loadSubaccounts();
      } catch (err) {
        toast(err.message.replace(/_/g, ' '), true);
      }
    });
  });
}

async function loadSubaccounts() {
  const res = await api('/api/subaccounts');
  subaccounts = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderSubaccounts();
}

document.getElementById('subaccountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const businessName = document.getElementById('subaccName').value.trim();
  const settlementBankCode = document.getElementById('subaccBankCode').value.trim();
  const settlementAccountNumber = document.getElementById('subaccAccountNumber').value.trim();
  const settlementAccountName = document.getElementById('subaccAccountName').value.trim();
  const splitRaw = document.getElementById('subaccSplit').value;
  const defaultSplitPercentage = splitRaw ? parseFloat(splitRaw) : undefined;

  try {
    await api('/api/subaccounts', {
      method: 'POST',
      body: JSON.stringify({
        businessName,
        settlementBankCode,
        settlementAccountNumber,
        settlementAccountName,
        defaultSplitPercentage,
      }),
    });
    toast('Subaccount added');
    e.target.reset();
    await loadSubaccounts();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

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
    loadSubaccounts(),
  ]);
  renderCharts();
}

/* ---------- Charts (Overview + Analytics tab) ---------- */
let _chartOvRevenue = null;
let _chartAnBar = null;
let _chartAnCandle = null;

function dayKey(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD
}

function lastNDays(n) {
  const days = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }
  return days;
}

const SETTLED_STATUSES = ['success', 'partial', 'over'];

function buildDailySeries(days) {
  // Returns { received: {day: minorTotal}, paid: {day: minorTotal}, ohlc: {day: {o,h,l,c}} }
  const received = {};
  const paid = {};
  const ohlc = {};
  days.forEach(d => { received[d] = 0; paid[d] = 0; });

  transactions.forEach(t => {
    if (!SETTLED_STATUSES.includes(t.status)) return;
    const key = dayKey(t.createdAt);
    const amt = (t.amountReceived || 0) / 100;
    if (key in received) received[key] += amt;

    if (!ohlc[key]) ohlc[key] = { o: amt, h: amt, l: amt, c: amt };
    else {
      const row = ohlc[key];
      row.h = Math.max(row.h, amt);
      row.l = Math.min(row.l, amt);
      row.c = amt; // transactions arrive sorted newest-first, so last write = earliest amount for the day; fine as an approximation of "close"
    }
  });

  payouts.forEach(p => {
    if (p.status !== 'successful') return;
    const key = dayKey(p.createdAt);
    if (key in paid) paid[key] += (p.amount || 0) / 100;
  });

  return { received, paid, ohlc };
}

function renderCharts() {
  if (typeof Chart === 'undefined') return; // CDN blocked / offline — charts simply don't render

  const days14 = lastNDays(14);
  const days30 = lastNDays(30);
  const series14 = buildDailySeries(days14);
  const series30 = buildDailySeries(days30);

  const shortLabel = (d) => new Date(d).toLocaleDateString('en-NG', { day: '2-digit', month: 'short' });

  // ---- Overview: 14-day revenue bar chart ----
  const ovCanvas = document.getElementById('ovRevenueChart');
  if (ovCanvas) {
    if (_chartOvRevenue) _chartOvRevenue.destroy();
    _chartOvRevenue = new Chart(ovCanvas, {
      type: 'bar',
      data: {
        labels: days14.map(shortLabel),
        datasets: [{
          label: 'Received',
          data: days14.map(d => series14.received[d]),
          backgroundColor: '#0ea5e9',
          borderRadius: 4,
          maxBarThickness: 26,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: (v) => '₦' + v.toLocaleString() } },
        },
      },
    });
  }

  // ---- Analytics: 30-day bar (received vs paid out) ----
  const anBarCanvas = document.getElementById('anBarChart');
  if (anBarCanvas) {
    if (_chartAnBar) _chartAnBar.destroy();
    _chartAnBar = new Chart(anBarCanvas, {
      type: 'bar',
      data: {
        labels: days30.map(shortLabel),
        datasets: [
          {
            label: 'Received',
            data: days30.map(d => series30.received[d]),
            backgroundColor: '#0ea5e9',
            borderRadius: 3,
            maxBarThickness: 14,
          },
          {
            label: 'Paid out',
            data: days30.map(d => series30.paid[d]),
            backgroundColor: '#7c3aed',
            borderRadius: 3,
            maxBarThickness: 14,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
          y: { beginAtZero: true, ticks: { callback: (v) => '₦' + v.toLocaleString() } },
        },
      },
    });
  }

  // ---- Analytics: candlestick (OHLC per day) ----
  const anCandleCanvas = document.getElementById('anCandleChart');
  if (anCandleCanvas) {
    const candleData = days30
      .filter(d => series30.ohlc[d])
      .map(d => ({
        x: new Date(d).getTime(),
        o: series30.ohlc[d].o,
        h: series30.ohlc[d].h,
        l: series30.ohlc[d].l,
        c: series30.ohlc[d].c,
      }));

    if (_chartAnCandle) _chartAnCandle.destroy();

    try {
      _chartAnCandle = new Chart(anCandleCanvas, {
        type: 'candlestick',
        data: { datasets: [{ label: 'Transaction range (₦)', data: candleData }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { x: { type: 'time', time: { unit: 'day' } } },
        },
      });
    } catch (e) {
      // financial plugin failed to load (offline/CDN blocked) — fall back to a line of daily closes
      _chartAnCandle = new Chart(anCandleCanvas, {
        type: 'line',
        data: {
          labels: candleData.map(p => new Date(p.x).toLocaleDateString('en-NG', { day: '2-digit', month: 'short' })),
          datasets: [{
            label: 'Daily close (₦)',
            data: candleData.map(p => p.c),
            borderColor: '#0ea5e9',
            backgroundColor: 'rgba(14,165,233,0.12)',
            fill: true,
            tension: 0.25,
          }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    }
  }

  renderInsights();
}

function renderInsights() {
  const settled = transactions.filter(t => SETTLED_STATUSES.includes(t.status));
  const avg = settled.length
    ? settled.reduce((s, t) => s + (t.amountReceived || 0), 0) / settled.length
    : 0;
  const successRate = transactions.length
    ? Math.round((settled.length / transactions.length) * 100)
    : 0;

  const days30set = new Set(lastNDays(30));
  const dayCounts = {};
  transactions.forEach(t => {
    const key = dayKey(t.createdAt);
    if (days30set.has(key)) dayCounts[key] = (dayCounts[key] || 0) + 1;
  });
  let busiestDay = '—';
  let busiestCount = 0;
  Object.entries(dayCounts).forEach(([d, c]) => {
    if (c > busiestCount) { busiestCount = c; busiestDay = d; }
  });

  const refundRate = settled.length
    ? Math.round((refunds.length / settled.length) * 100)
    : 0;

  const openDisputes = disputes.filter(d => ['open', 'under_review'].includes(d.status)).length;
  const activeSubs = subscriptions.filter(s => s.status === 'active').length;

  setText('anAvgVal', money(avg));
  setText('anSuccessRate', transactions.length ? `${successRate}%` : '—');
  setText('anBusiestDay', busiestCount ? `${new Date(busiestDay).toLocaleDateString('en-NG', { day: '2-digit', month: 'short' })} (${busiestCount})` : '—');
  setText('anRefundRate', settled.length ? `${refundRate}%` : '—');
  setText('anOpenDisputes', String(openDisputes));
  setText('anActiveSubs', String(activeSubs));

  const emptyNote = document.getElementById('anEmptyNote');
  if (emptyNote) emptyNote.style.display = transactions.length ? 'none' : 'flex';
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

document.getElementById('qaPosBtn')?.addEventListener('click', () => {
  toast('POS terminals — coming soon');
});

document.getElementById('qaLinkBtn')?.addEventListener('click', () => {
  const amt = document.getElementById('linkAmount');
  if (amt) {
    amt.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => amt.focus(), 300);
  }
});

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

(function setOverviewDateRange() {
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);
  setText('ovRangeStart', fmt(start));
  setText('ovRangeEnd', fmt(end));
})();
