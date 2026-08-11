let transactions = [];
let payouts = [];
let txFilter = '';
let txSearch = '';

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

/* ---------- Section tabs ---------- */
function showTab(name) {
  document.querySelectorAll('.section-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}
document.querySelectorAll('.section-tab').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
document.querySelectorAll('[data-goto]').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.goto));
});

/* ---------- Loaders ---------- */
async function loadProfile() {
  const res = await api('/api/merchant/me');
  document.getElementById('bizName').firstChild.textContent = res.data.businessName + ' ';
  document.getElementById('bizEmail').textContent = res.data.email;
  document.getElementById('webhookUrlInput').value = res.data.webhookUrl || '';

  const modeBadge = document.getElementById('modeBadge');
  const mode = res.data.mode || 'test';
  modeBadge.textContent = `${mode} mode`;
  modeBadge.classList.toggle('live', mode === 'live');

  document.getElementById('setBizName').textContent = res.data.businessName;
  document.getElementById('setBizEmail').textContent = res.data.email;
  document.getElementById('setPubKey').textContent = res.data.publicKey || '—';
  document.getElementById('setMode').textContent = mode;
}

async function loadWallet() {
  const res = await api('/api/wallet');
  document.getElementById('walletBalance').textContent = money(res.data.balance);
}

function renderTxRow(t) {
  return `
    <tr>
      <td>${t.reference || t.bankReference || '—'}</td>
      <td><span class="status-pill status-${t.status}">${t.status}</span></td>
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
        <td>${t.reference || t.bankReference || '—'}</td>
        <td><span class="status-pill status-${t.status}">${t.status}</span></td>
        <td>${money(t.amountReceived)}</td>
        <td>${fmtDate(t.createdAt)}</td>
      </tr>`).join('');
  }
}

async function loadTransactions() {
  const res = await api('/api/transactions');
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
}

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
      <td>${p.reference}</td>
      <td><span class="status-pill status-${p.status}">${p.status}</span></td>
      <td>${money(p.amount)}</td>
      <td>${p.destinationAccountNumber} (${p.destinationBankCode})</td>
      <td>${fmtDate(p.createdAt)}</td>
    </tr>`).join('');
}

async function loadPayouts() {
  const res = await api('/api/payouts');
  payouts = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const paidOut = payouts
    .filter(p => p.status === 'successful')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  document.getElementById('payoutVolume').textContent = money(paidOut);
  document.getElementById('payoutCountNote').textContent = `${payouts.length} payout${payouts.length === 1 ? '' : 's'}`;

  renderPayouts();
}

async function refreshAll() {
  await Promise.all([loadProfile(), loadWallet(), loadTransactions(), loadPayouts()]);
}

/* ---------- Event wiring ---------- */
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
            <div class="k-val" id="genLink">${res.data.link}</div>
            <button type="button" class="btn btn-sm copy-btn" id="copyLinkBtn">Copy</button>
          </div>
        </div>
        <div class="key-row" style="margin-top:10px;">
          <div class="k-label">Virtual account</div>
          <div class="k-val">${res.data.accountNumber}</div>
        </div>
      </div>`;
    document.getElementById('copyLinkBtn').addEventListener('click', () => copyToClipboard(res.data.link));
    toast('Payment link generated');
    await loadTransactions();
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

document.getElementById('regenKeyBtn').addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Generate a new secret key? Your current key will stop working immediately — ' +
    'update it anywhere you use it before continuing.'
  );
  if (!confirmed) return;

  try {
    const res = await api('/api/merchant/regenerate-key', { method: 'POST' });
    document.getElementById('regenKeyResult').innerHTML = `
      <div class="key-reveal" style="margin-top:16px;">
        <div class="warn">Store this now — it will not be shown again.</div>
        <div class="key-row">
          <div class="k-label">Secret key</div>
          <div class="link-row">
            <div class="k-val" id="newSecretKey">${res.data.secretKey}</div>
            <button type="button" class="btn btn-sm copy-btn" id="copyKeyBtn">Copy</button>
          </div>
        </div>
      </div>`;
    document.getElementById('copyKeyBtn').addEventListener('click', () => copyToClipboard(res.data.secretKey));
    toast('New secret key generated');
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
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
