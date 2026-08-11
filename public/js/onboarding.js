
  const tabRegister = document.getElementById('tab-register');
  const tabLogin = document.getElementById('tab-login');
  const registerForm = document.getElementById('registerForm');
  const loginForm = document.getElementById('loginForm');
  const errBox = document.getElementById('err');
  const keyReveal = document.getElementById('keyReveal');

  function showTab(name) {
    const isRegister = name === 'register';
    tabRegister.classList.toggle('active', isRegister);
    tabLogin.classList.toggle('active', !isRegister);
    registerForm.style.display = isRegister ? 'block' : 'none';
    loginForm.style.display = isRegister ? 'none' : 'block';
    keyReveal.style.display = 'none';
    errBox.classList.remove('show');
  }
  tabRegister.addEventListener('click', () => showTab('register'));
  tabLogin.addEventListener('click', () => showTab('login'));

  const params = new URLSearchParams(location.search);
  showTab(params.get('tab') === 'login' ? 'login' : 'register');

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.add('show');
  }

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.remove('show');
    const data = Object.fromEntries(new FormData(registerForm));
    try {
      const res = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(data) });
      document.getElementById('revealSecret').textContent = res.data.secretKey;
      document.getElementById('revealWebhookSecret').textContent = res.data.webhookSecret;
      registerForm.style.display = 'none';
      keyReveal.style.display = 'block';
    } catch (err) {
      showError(err.message.replace(/_/g, ' '));
    }
  });

  document.getElementById('continueBtn').addEventListener('click', () => {
    showTab('login');
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.remove('show');
    const data = Object.fromEntries(new FormData(loginForm));
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
      window.location.href = '/dashboard.html';
    } catch (err) {
      showError(err.message.replace(/_/g, ' '));
    }
  });
