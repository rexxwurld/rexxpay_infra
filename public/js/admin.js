// Admin dashboard for the account pool. Auth is the same INFRA_ADMIN_KEY
// the /api/admin/* routes already require (see adminKey.middleware.js) -
// no separate admin session/JWT exists yet. The key lives only in
// sessionStorage (cleared when the tab closes) and is sent as the
// x-admin-key header on every request, same as a curl/Postman call.

const KEY_STORAGE = 'swiftpay_admin_key';

function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function getKey() {
  return sessionStorage.getItem(KEY_STORAGE);
}

function setKey(key) {
  sessionStorage.setItem(KEY_STORAGE, key);
}

function clearKey() {
  sessionStorage.removeItem(KEY_STORAGE);
}

async function adminApi(path, options = {}) {
  const key = getKey();
  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': key || '',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 401) {
    clearKey();
    showLogin('Invalid or expired admin key.');
    throw new Error('unauthorized');
  }
  if (!res.ok || body.status === false) {
    throw new Error(body.message || `request_failed_${res.status}`);
  }
  return body;
}

function showLogin(errMsg) {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('dashScreen').style.display = 'none';
  document.getElementById('logoutBtn').style.display = 'none';
  const errEl = document.getElementById('loginErr');
  if (errMsg) {
    errEl.textContent = errMsg;
    errEl.classList.add('show');
  } else {
    errEl.classList.remove('show');
  }
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashScreen').style.display = 'block';
  document.getElementById('logoutBtn').style.display = 'inline-block';
  loadPoolStatus();
}

/* ---------- Pool status ---------- */

let lastPool = [];

async function loadPoolStatus() {
  try {
    const res = await adminApi('/pool-status');
    lastPool = res.data || [];
    renderPoolTable(lastPool);
    renderBankSelect(lastPool);
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, true);
  }
}

function renderPoolTable(rows) {
  const body = document.getElementById('poolTableBody');
  const empty = document.getElementById('poolEmpty');

  if (!rows.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const LOW_THRESHOLD = 20; // mirrors POOL_MIN_THRESHOLD default - display only

  // Only the LIVE pool is a real operational resource - test accounts
  // are generated on demand for free (see provisionAccountPool), so
  // there's nothing to show for test here.
  body.innerHTML = rows.map((r) => {
    const low = r.live.available <= LOW_THRESHOLD;
    return `
      <tr>
        <td class="mono">${r.bank}</td>
        <td class="mono">${r.live.available}</td>
        <td class="mono">${r.live.assigned}</td>
        <td><span class="pill ${low ? 'low' : 'ok'}">${low ? 'Low' : 'Healthy'}</span></td>
      </tr>
    `;
  }).join('');
}

function renderBankSelect(rows) {
  const select = document.getElementById('bankSelect');
  const current = select.value;
  select.innerHTML = rows.map((r) => `<option value="${r.bank}">${r.bank}</option>`).join('');
  if (current && rows.some((r) => r.bank === current)) select.value = current;
}

/* ---------- Provision ---------- */

async function provisionPool() {
  const bankSlug = document.getElementById('bankSelect').value;
  const count = parseInt(document.getElementById('countInput').value, 10) || 20;

  if (!bankSlug) {
    toast('No bank selected.', true);
    return;
  }

  const btn = document.getElementById('provisionBtn');
  btn.disabled = true;
  try {
    // Always live - test-mode accounts are minted on demand per
    // checkout and are never pre-provisioned (see bankPartner.service.js).
    const res = await adminApi(
      `/provision-pool?bankSlug=${encodeURIComponent(bankSlug)}&count=${count}&mode=live`,
      { method: 'GET' }
    );
    toast(res.message || 'Provisioned.');
    await loadPoolStatus();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Wiring ---------- */

document.getElementById('unlockBtn').addEventListener('click', async () => {
  const input = document.getElementById('adminKeyInput');
  const key = input.value.trim();
  if (!key) return;

  setKey(key);
  try {
    await adminApi('/pool-status'); // validates the key
    showDashboard();
  } catch (err) {
    // showLogin() with the error was already called by adminApi on 401
    if (err.message !== 'unauthorized') toast(err.message, true);
  }
});

document.getElementById('adminKeyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('unlockBtn').click();
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearKey();
  showLogin();
});

document.getElementById('refreshBtn').addEventListener('click', loadPoolStatus);
document.getElementById('provisionBtn').addEventListener('click', provisionPool);

/* ---------- Init ---------- */

if (getKey()) {
  showDashboard();
} else {
  showLogin();
}
