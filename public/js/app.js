/* =====================================================================
   Tasker — Complete SPA (Vanilla JS, mobile-first, no frameworks)
   ===================================================================== */
'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

const state = {
  csrfToken: null,
  user: null,           // { username, isAdmin, mustChangePassword }
  registrationConfig: null, // { selfRegistration, userInvite }
  appStats: null,       // { userCount, eventCount }
  activeTask: null,     // current in_progress task
  timerInterval: null,
  activityInterval: null,
  inactivityCheckInterval: null,
  interruptStart: null, // ISO string set when interrupt modal opens
  currentView: null,
  dropdowns: { category: [], subcategory: [], outcome: [] },
  taskForm: {},
  editTask: null,
  charts: {},
  pendingTaskLog: null,  // { count, logged_at } — most recent pending task snapshot
  recentHandledCount: null,  // number — tasks completed in the last 7 days
};

// ── History management ────────────────────────────────────────────────────────
let _popstateActive = false;

function pushHistory(view) {
  if (_popstateActive || window.history.state?.view === view) return;
  window.history.pushState({ view }, '', window.location.pathname);
}

function replaceHistory(view) {
  window.history.replaceState({ view }, '', window.location.pathname);
}

// ── Asset version check ───────────────────────────────────────────────────────
async function checkAssetVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return false;
    const { version } = await r.json();
    const stored = localStorage.getItem('tasker_app_version');
    if (stored !== null && stored !== version) {
      localStorage.setItem('tasker_app_version', version);
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(reg => reg.unregister()));
      }
      window.location.reload();
      return true;
    }
    localStorage.setItem('tasker_app_version', version);
    return false;
  } catch (e) {
    return false;
  }
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
const app = () => document.getElementById('app');
const esc = str => str == null ? '' : String(str)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#039;');

function isMobileDevice() {
  return /Mobile|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getAppVersion() {
  return localStorage.getItem('tasker_app_version') || '…';
}

function renderFooter() {
  const v = getAppVersion();
  return `<p style="text-align:center;font-size:.75rem;color:#9ca3af;padding:8px 0 16px">v${v} &nbsp;·&nbsp; <a href="/policy" target="_blank" style="color:#9ca3af">Privacy Policy</a> &nbsp;·&nbsp; <a href="/help" target="_blank" style="color:#9ca3af">Help</a><br>© J Rowson ${new Date().getFullYear()} | <a href="https://jahosi.co.uk" target="_blank" style="color:#9ca3af">jahosi.co.uk</a></p>`;
}

function showAlert(msg, type = 'error', parentId = null) {
  const el = document.createElement('div');
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  const parent = parentId ? document.getElementById(parentId) : app();
  if (parent) parent.prepend(el);
  setTimeout(() => el.remove(), 6000);
}

function clearCharts() {
  Object.values(state.charts).forEach(c => { try { c.destroy(); } catch(e){} });
  state.charts = {};
}

function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

// ── Inactivity / activity tracking ──────────────────────────────────────────
function updateLastActive() {
  try { localStorage.setItem('tasker_last_active', Date.now().toString()); } catch(e) {}
}

function getLastActive() {
  try { const v = localStorage.getItem('tasker_last_active'); return v ? parseInt(v, 10) : null; } catch(e) { return null; }
}

const ACTIVITY_EVENTS = ['click', 'touchstart', 'keydown', 'scroll'];

function startActivityTracking() {
  stopActivityTracking();
  updateLastActive();
  state.activityInterval = setInterval(updateLastActive, 60000);
  ACTIVITY_EVENTS.forEach(evt => document.addEventListener(evt, updateLastActive, { passive: true }));
  state.inactivityCheckInterval = setInterval(checkClientInactivity, 60000);
}

function stopActivityTracking() {
  if (state.activityInterval) { clearInterval(state.activityInterval); state.activityInterval = null; }
  if (state.inactivityCheckInterval) { clearInterval(state.inactivityCheckInterval); state.inactivityCheckInterval = null; }
  ACTIVITY_EVENTS.forEach(evt => document.removeEventListener(evt, updateLastActive));
}

async function forceSessionExpiry() {
  stopActivityTracking();
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': state.csrfToken || '' },
      credentials: 'same-origin',
    });
  } catch(e) { console.warn('[Tasker] Logout request failed during session expiry:', e); }
  state.user = null;
  state.activeTask = null;
  state.csrfToken = null;
  state.registrationConfig = null;
  renderInactivityLogout();
}

function renderInactivityLogout() {
  stopTimer(); stopActivityTracking(); clearCharts(); state.currentView = 'inactivity-logout';
  replaceHistory('login');
  app().innerHTML = `
  <div class="view" style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;text-align:center">
    <div style="font-size:3rem;margin-bottom:16px">🔒</div>
    <h1 style="font-size:1.5rem;color:#1a56db;margin-bottom:16px">You have been logged out</h1>
    <div class="alert alert-warning" style="max-width:400px;margin-bottom:24px;text-align:left">
      <p style="margin-bottom:8px">You have been logged out due to <strong>30 minutes of inactivity</strong>.</p>
      <p>Any task you were working on has been suspended.</p>
    </div>
    <button class="btn btn-primary" onclick="returnToLogin()" style="min-width:220px">🔑 Click here to log in again</button>
  </div>`;
}

async function returnToLogin() {
  try { await refreshCsrf(); } catch(e) {}
  await renderLogin();
}

function checkClientInactivity() {
  if (!state.user) return;
  const last = getLastActive();
  if (last && Date.now() - last > INACTIVITY_MS) {
    forceSessionExpiry();
  }
}

// When the page becomes visible again, immediately check if the session has expired
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkClientInactivity();
});

async function checkInactivityInterruption() {
  if (!state.activeTask) return false;
  const last = getLastActive();
  if (!last) return false;
  const taskStart = new Date(state.activeTask.start_time).getTime();
  const effectiveLast = Math.max(last, taskStart);
  const gap = Date.now() - effectiveLast;
  if (gap < INACTIVITY_MS) return false;
  const t = state.activeTask;
  const interruptions = [...(t.interruptions || []), {
    start: new Date(effectiveLast).toISOString(),
    end: new Date().toISOString(),
  }];
  try {
    await api('PATCH', `/api/tasks/${t.id}`, { interruptions });
    t.interruptions = interruptions;
    return true;
  } catch(e) {
    console.error('[Tasker] Failed to record inactivity interruption:', e);
  }
  return false;
}

// ── API helper ──────────────────────────────────────────────────────────────
async function api(method, url, body, isFormData) {
  const headers = {};
  let fetchBody;
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = state.csrfToken || '';
    if (isFormData) { fetchBody = body; }
    else { headers['Content-Type'] = 'application/json'; fetchBody = JSON.stringify(body || {}); }
  }
  const res = await fetch(url, { method, headers, body: fetchBody, credentials: 'same-origin' });
  if (res.status === 401 && url !== '/api/auth/login') { await renderLogin(); return null; }
  if (res.status === 429) {
    const retryAfter = res.headers.get('RateLimit-Reset') || res.headers.get('Retry-After');
    const wait = retryAfter ? ` Please wait ${Math.ceil((parseInt(retryAfter, 10) * 1000 - Date.now()) / 60000)} minute(s).` : ' Please wait a few minutes.';
    throw new Error(`Too many requests.${wait}`);
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const d = await res.json(); msg = d.error || msg; } catch(e){}
    throw new Error(msg);
  }
  if (res.headers.get('content-type')?.includes('json')) return res.json();
  return res;
}

async function refreshCsrf() {
  const d = await fetch('/api/auth/csrf-token', { credentials: 'same-origin' });
  if (!d.ok) return; // Don't overwrite existing token on error (e.g. 429)
  const j = await d.json();
  state.csrfToken = j.token;
}

// ── App init ─────────────────────────────────────────────────────────────────
function setLoadingStatus(msg) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg;
}

function showLoadingError(msg) {
  const errEl = document.getElementById('loading-error');
  const actEl = document.getElementById('loading-actions');
  const spinnerEl = document.querySelector('.loading-spinner');
  if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  if (actEl) { actEl.hidden = false; }
  if (spinnerEl) { spinnerEl.classList.add('loading-spinner--error'); }
}

async function init() {
  const errEl = document.getElementById('loading-error');
  const actEl = document.getElementById('loading-actions');
  const spinnerEl = document.querySelector('.loading-spinner');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  if (actEl) { actEl.hidden = true; }
  if (spinnerEl) { spinnerEl.classList.remove('loading-spinner--error'); }
  setLoadingStatus('Starting…');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  setLoadingStatus('Checking for updates…');
  if (await checkAssetVersion()) return; // Version mismatch — page will reload with fresh assets

  try {
    setLoadingStatus('Fetching security token…');
    await refreshCsrf();

    setLoadingStatus('Checking session…');
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (me.ok) {
      state.user = await me.json();
      if (state.user.mustChangePassword) { renderChangePassword(); return; }
      if (state.user.pendingActivation) { renderAwaitActivation(); return; }

      setLoadingStatus('Loading dropdown options…');
      await loadDropdowns();

      setLoadingStatus('Checking active task…');
      await checkActiveTask();
      startActivityTracking();

      setLoadingStatus('Rendering…');
      await (state.user.isAdmin ? renderAdmin() : renderHome());
    } else {
      await renderLogin();
    }
  } catch(e) {
    showLoadingError(`Initialization failed: ${e.message || e}`);
  }
}

async function loadDropdowns() {
  try {
    const [cats, subs, outs] = await Promise.all([
      api('GET','/api/dropdowns/category'),
      api('GET','/api/dropdowns/subcategory'),
      api('GET','/api/dropdowns/outcome'),
    ]);
    if (cats) state.dropdowns.category = cats.options;
    if (subs) state.dropdowns.subcategory = subs.options;
    if (outs) state.dropdowns.outcome = outs.options;
  } catch(e) {}
}

async function checkActiveTask() {
  try {
    const d = await api('GET', '/api/tasks/active');
    state.activeTask = d?.task || null;
  } catch(e) { state.activeTask = null; }
}

// ── Bottom nav ───────────────────────────────────────────────────────────────
function renderBottomNav(active) {
  return `<nav class="nav-bottom">
    <button class="nav-btn ${active==='home'?'active':''}" onclick="renderHome()">
      <span class="nav-icon">🏠</span><span>Home</span>
    </button>
    <button class="nav-btn ${active==='analytics'?'active':''}" onclick="renderAnalyticsSession()">
      <span class="nav-icon">📊</span><span>Analytics</span>
    </button>
    <button class="nav-btn ${active==='settings'?'active':''}" onclick="renderSettings()">
      <span class="nav-icon">⚙️</span><span>Settings</span>
    </button>
  </nav>
  ${renderFooter()}`;
}

// ── STATS CARDS ──────────────────────────────────────────────────────────────
function renderStatsCards(stats, marginTop = '20px') {
  if (!stats) return '';
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:${marginTop}">
      <div class="stat-card"><div class="stat-number">${stats.userCount}</div><div class="stat-label">Registered users</div></div>
      <div class="stat-card"><div class="stat-number">${stats.eventCount}</div><div class="stat-label">Events logged</div></div>
    </div>`;
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
async function renderLogin() {
  stopTimer(); stopActivityTracking(); clearCharts(); state.currentView = 'login';
  replaceHistory('login');
  // Force a refresh of the local SW cache so stale assets can't cause CSRF token mismatches
  if ('caches' in window) {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => {});
  }
  // Fetch registration config and public stats in parallel
  try {
    const [cfgRes, statsRes] = await Promise.all([
      fetch('/api/auth/registration-config', { credentials: 'same-origin' }),
      fetch('/api/auth/stats', { credentials: 'same-origin' }),
    ]);
    if (cfgRes.ok) state.registrationConfig = await cfgRes.json();
    if (statsRes.ok) state.appStats = await statsRes.json();
  } catch(e) {}
  const showRegister = state.registrationConfig?.selfRegistration !== 'disabled';
  const statsHTML = renderStatsCards(state.appStats, '20px');
  app().innerHTML = `
  <div class="view" style="min-height:auto;padding-bottom:24px">
    <div style="text-align:center;padding-top:30px;margin-bottom:28px">
      <div style="font-size:3rem">📱</div>
      <h1 style="font-size:1.8rem;color:#1a56db;margin-top:8px">Tasker</h1>
      <p style="color:#6b7280;font-size:.9rem;margin-top:4px">Helping you analyse your admin workload</p>
    </div>
    <div id="login-alerts"></div>
    <div class="card">
      <div class="form-group">
        <label for="l-user">Username</label>
        <input id="l-user" class="input" type="text" autocomplete="username" autocapitalize="off" placeholder="Enter your username">
      </div>
      <div class="form-group">
        <label for="l-pass">Password</label>
        <div class="pw-field">
          <input id="l-pass" class="input" type="password" autocomplete="current-password" placeholder="Your password">
          <button class="pw-toggle" type="button" onclick="togglePw('l-pass',this)">👁️</button>
        </div>
      </div>
      <button class="btn btn-primary btn-full" id="l-btn" onclick="doLogin()">Log in</button>
    </div>
    <div style="text-align:center;margin-top:16px;display:flex;flex-direction:column;gap:10px">
      ${showRegister ? `<button class="link-btn" onclick="renderRegister()">Don't have an account? Register</button>` : ''}
      <a href="/policy" target="_blank" style="font-size:.85rem;color:#6b7280">Data &amp; Use Policy</a>
    </div>
    ${statsHTML}
    ${renderFooter()}
  </div>`;
  document.getElementById('l-user').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('l-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

function togglePw(id, btn) {
  const el = document.getElementById(id);
  if (el.type === 'password') { el.type = 'text'; btn.textContent = '🙈'; }
  else { el.type = 'password'; btn.textContent = '👁️'; }
}

async function doLogin() {
  const btn = document.getElementById('l-btn');
  const username = document.getElementById('l-user').value.trim();
  const password = document.getElementById('l-pass').value;
  if (!username || !password) { showAlert('Enter username and password.', 'error', 'login-alerts'); return; }
  btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    const d = await api('POST', '/api/auth/login', { username, password });
    if (!d) return;
    state.user = { username, isAdmin: d.isAdmin, mustChangePassword: d.mustChangePassword, pendingActivation: d.pendingActivation };
    await refreshCsrf();
    if (d.mustChangePassword) { renderChangePassword(); return; }
    if (d.pendingActivation) { renderAwaitActivation(); return; }
    await loadDropdowns();
    await checkActiveTask();
    startActivityTracking();
    renderPrivacySplash(() => { d.isAdmin ? renderAdmin() : renderHome(); });
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Log in';
    showAlert(e.message, 'error', 'login-alerts');
  }
}

// ── PRIVACY SPLASH ───────────────────────────────────────────────────────────
function renderPrivacySplash(onContinue) {
  const overlay = document.createElement('div');
  overlay.id = 'privacy-splash';
  overlay.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;overflow-y:auto;padding:24px 20px 32px';
  overlay.innerHTML = `
  <div style="max-width:480px;width:100%">
    <div style="text-align:center;margin-bottom:24px;padding-top:12px">
      <div style="font-size:2.5rem">🔒</div>
      <h1 style="font-size:1.4rem;color:#1a56db;margin:8px 0 4px">Data Privacy Notice</h1>
      <p style="font-size:.85rem;color:#6b7280">Please read carefully before continuing</p>
    </div>
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:16px;margin-bottom:16px">
      <p style="font-weight:700;color:#dc2626;margin:0 0 10px;font-size:.95rem">⛔ Prohibited — Never enter in any text field:</p>
      <ul style="font-size:.85rem;color:#374151;margin:0;padding-left:20px;line-height:2">
        <li>Patient names, initials, or any identifier</li>
        <li>NHS numbers, dates of birth, or addresses</li>
        <li>Anything that could identify a patient, colleague, or third party</li>
        <li>Confidential clinical details</li>
      </ul>
    </div>
    <div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;padding:16px;margin-bottom:16px">
      <p style="font-weight:700;color:#1d4ed8;margin:0 0 10px;font-size:.95rem">🔒 Your Privacy</p>
      <ul style="font-size:.85rem;color:#374151;margin:0;padding-left:20px;line-height:2">
        <li>Your username is anonymous and cannot be linked to you</li>
        <li>All data is automatically deleted after 30 days</li>
        <li>Only you can see your task data</li>
        <li>Use a personal device on a personal network only</li>
      </ul>
    </div>
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px;margin-bottom:24px">
      <p style="font-size:.85rem;color:#374151;margin:0">By continuing, you confirm you have read this notice and will <strong>not enter any identifiable or prohibited information</strong> anywhere in this application.</p>
    </div>
    <button id="splash-continue-btn" style="width:100%;padding:16px;background:#1a56db;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer">
      ✓ I Understand — Continue
    </button>
    <p style="text-align:center;font-size:.75rem;color:#9ca3af;margin-top:16px">
      <a href="/policy" target="_blank" style="color:#9ca3af">View full Data &amp; Use Policy</a>
    </p>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('splash-continue-btn').addEventListener('click', () => {
    overlay.remove();
    onContinue();
  });
}

// ── REGISTER ─────────────────────────────────────────────────────────────────
function renderRegister() {
  stopTimer(); clearCharts(); state.currentView = 'register';
  pushHistory('register');
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <button class="btn btn-secondary btn-sm" onclick="renderLogin()">← Back</button>
      <h1>Register</h1>
    </div>
    <div id="reg-alerts"></div>
    <div class="alert alert-info">
      <strong>Your username will be auto-generated</strong> — a unique memorable word pair. 
      You'll see it after setting your password. <strong>Write it down</strong> — it cannot be recovered.
    </div>
    <div class="card">
      <div class="form-group">
        <label for="r-pass">Choose a password</label>
        <div class="pw-field">
          <input id="r-pass" class="input" type="password" autocomplete="new-password" placeholder="Min 8 chars + special character">
          <button class="pw-toggle" type="button" onclick="togglePw('r-pass',this)">👁️</button>
        </div>
        <p style="font-size:.8rem;color:#6b7280;margin-top:4px">Min 8 characters, at least 1 special character (!@#$%…)</p>
      </div>
      <div class="form-group">
        <label for="r-pass2">Confirm password</label>
        <input id="r-pass2" class="input" type="password" autocomplete="new-password" placeholder="Repeat password">
      </div>
      <div class="form-group" style="display:flex;align-items:flex-start;gap:10px">
        <input id="r-policy" type="checkbox" style="margin-top:3px;width:18px;height:18px;flex-shrink:0">
        <label for="r-policy" style="font-size:.9rem;font-weight:400">
          I have read the <a href="/policy" target="_blank">Data &amp; Use Policy</a> and 
          I understand I must <strong>never enter patient or identifiable information</strong>.
        </label>
      </div>
      <button class="btn btn-primary btn-full" id="r-btn" onclick="doRegister()">Register</button>
    </div>
  </div>`;
}

async function doRegister() {
  const btn = document.getElementById('r-btn');
  const pass = document.getElementById('r-pass').value;
  const pass2 = document.getElementById('r-pass2').value;
  const policy = document.getElementById('r-policy').checked;
  if (!policy) { showAlert('Please read and accept the Data & Use Policy.', 'error', 'reg-alerts'); return; }
  if (pass !== pass2) { showAlert('Passwords do not match.', 'error', 'reg-alerts'); return; }
  btn.disabled = true; btn.textContent = 'Registering…';
  try {
    const d = await api('POST', '/api/auth/register', { password: pass });
    if (!d) return;
    if (d.pending) {
      showRegisterPending(d.username);
    } else {
      showRegisterSuccess(d.username);
    }
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Register';
    showAlert(e.message, 'error', 'reg-alerts');
  }
}

function showRegisterPending(username) {
  app().innerHTML = `
  <div class="view">
    <h1 style="margin-bottom:16px;color:#d97706">⏳ Awaiting Approval</h1>
    <div class="alert alert-warning">
      ⚠️ <strong>Save your username now.</strong> It cannot be recovered if lost.
    </div>
    <div class="username-box">
      <p style="font-size:.9rem;color:#374151;margin-bottom:4px">Your username is:</p>
      <span class="username-text">${esc(username)}</span>
      <button class="btn btn-outline btn-sm" style="margin-top:10px" onclick="navigator.clipboard?.writeText('${esc(username)}').then(()=>showAlert('Copied!','success'))">📋 Copy</button>
    </div>
    <div class="alert alert-info" style="margin-top:16px">
      Your registration has been submitted and is awaiting administrator approval. 
      You will be able to log in once your account has been approved.
    </div>
    <button class="btn btn-primary btn-full" onclick="renderLogin()">Go to Login</button>
  </div>`;}

function showRegisterSuccess(username) {
  app().innerHTML = `
  <div class="view">
    <h1 style="margin-bottom:16px;color:#16a34a">✅ Registered!</h1>
    <div class="alert alert-warning">
      ⚠️ <strong>Save your username now.</strong> It cannot be recovered if lost.
    </div>
    <div class="username-box">
      <p style="font-size:.9rem;color:#374151;margin-bottom:4px">Your username is:</p>
      <span class="username-text">${esc(username)}</span>
      <button class="btn btn-outline btn-sm" style="margin-top:10px" onclick="navigator.clipboard?.writeText('${esc(username)}').then(()=>showAlert('Copied!','success'))">📋 Copy</button>
    </div>
    <p style="font-size:.9rem;color:#374151;margin-bottom:20px">
      Use this username every time you log in. It is anonymous — no one can link it to your real identity.
    </p>
    <button class="btn btn-primary btn-full" onclick="renderLogin()">Go to Login</button>
  </div>`;
}

// ── AWAIT ACTIVATION ─────────────────────────────────────────────────────────
function renderAwaitActivation() {
  stopTimer(); clearCharts(); state.currentView = 'await-activation';
  replaceHistory('await-activation');
  const username = state.user?.username || '';
  app().innerHTML = `
  <div class="view">
    <h1 style="margin-bottom:16px;color:#d97706">⏳ Awaiting Activation</h1>
    <div class="alert alert-warning">
      Your account has been created and your password is set.
      An administrator needs to activate your account before you can start logging tasks.
    </div>
    ${username ? `<div class="username-box">
      <p style="font-size:.9rem;color:#374151;margin-bottom:4px">Your username is:</p>
      <span class="username-text">${esc(username)}</span>
      <button class="btn btn-outline btn-sm" style="margin-top:10px" onclick="navigator.clipboard?.writeText('${esc(username)}').then(()=>showAlert('Copied!','success','await-alerts'))">📋 Copy</button>
    </div>` : ''}
    <div id="await-alerts"></div>
    <div class="alert alert-info" style="margin-top:16px">
      Please check back later. Once activated, log in again to access Tasker.
    </div>
    <button class="btn btn-secondary btn-full" style="margin-top:16px" onclick="doLogout()">🚪 Log Out</button>
  </div>`;
}

// ── CHANGE PASSWORD ──────────────────────────────────────────────────────────
function renderChangePassword() {
  stopTimer(); clearCharts(); state.currentView = 'change-password';
  const isForced = state.user?.mustChangePassword;
  if (isForced) { replaceHistory('change-password'); } else { pushHistory('change-password'); }
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      ${!isForced ? `<button class="btn btn-secondary btn-sm" onclick="${state.user?.isAdmin ? 'renderAdmin' : 'renderHome'}()">← Back</button>` : ''}
      <h1>Change Password</h1>
    </div>
    ${isForced ? '<div class="alert alert-warning">⚠️ You must set a new password before continuing.</div>' : ''}
    <div id="cp-alerts"></div>
    <div class="card">
      ${!isForced ? `
      <div class="form-group">
        <label for="cp-old">Current password</label>
        <div class="pw-field">
          <input id="cp-old" class="input" type="password" autocomplete="current-password">
          <button class="pw-toggle" type="button" onclick="togglePw('cp-old',this)">👁️</button>
        </div>
      </div>` : ''}
      <div class="form-group">
        <label for="cp-new">New password</label>
        <div class="pw-field">
          <input id="cp-new" class="input" type="password" autocomplete="new-password" placeholder="Min 8 chars + special character">
          <button class="pw-toggle" type="button" onclick="togglePw('cp-new',this)">👁️</button>
        </div>
      </div>
      <div class="form-group">
        <label for="cp-new2">Confirm new password</label>
        <input id="cp-new2" class="input" type="password" autocomplete="new-password">
      </div>
      <button class="btn btn-primary btn-full" id="cp-btn" onclick="doChangePassword(${isForced})">Save new password</button>
    </div>
  </div>`;
  const cpEnter = e => { if (e.key === 'Enter') doChangePassword(isForced); };
  document.getElementById('cp-new').addEventListener('keydown', cpEnter);
  document.getElementById('cp-new2').addEventListener('keydown', cpEnter);
  if (!isForced) document.getElementById('cp-old')?.addEventListener('keydown', cpEnter);
}

async function doChangePassword(isForced) {
  const btn = document.getElementById('cp-btn');
  const newPass = document.getElementById('cp-new').value;
  const newPass2 = document.getElementById('cp-new2').value;
  const oldPass = isForced ? '' : (document.getElementById('cp-old')?.value || '');
  if (newPass !== newPass2) { showAlert('Passwords do not match.', 'error', 'cp-alerts'); return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const d = await api('POST', '/api/auth/change-password', { currentPassword: oldPass, newPassword: newPass });
    if (state.user) state.user.mustChangePassword = false;
    if (d?.pendingActivation) {
      if (state.user) state.user.pendingActivation = true;
      showAlert('Password changed successfully!', 'success', 'cp-alerts');
      setTimeout(() => renderAwaitActivation(), 1000);
      return;
    }
    await loadDropdowns();
    await checkActiveTask();
    showAlert('Password changed successfully!', 'success', 'cp-alerts');
    setTimeout(() => {
      renderPrivacySplash(() => { state.user?.isAdmin ? renderAdmin() : renderHome(); });
    }, 800);
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Save new password';
    showAlert(e.message, 'error', 'cp-alerts');
  }
}

// ── HOME ─────────────────────────────────────────────────────────────────────
function renderHomeHTML() {
  const t = state.activeTask;
  const midnightWarn = checkMidnightWarn();
  const statsHTML = renderStatsCards(state.appStats, '16px');
  return `
  <div class="view">
    <div class="view-header">
      <h1>👋 Tasker</h1>
    </div>
    <div class="retention-notice">⏳ Your data is automatically deleted after 30 days.</div>
    ${midnightWarn ? '<div class="midnight-warn">⚠️ Approaching midnight — your session will end at midnight. Complete any active task.</div>' : ''}
    <div id="home-alerts"></div>
    ${t ? `
    <div class="card" style="border: 2px solid #f59e0b">
      <div class="card-title">⏸️ Task In Progress</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? 'My Group' : 'Personal'}</span>
        ${t.category ? `<span style="font-size:.9rem;color:#374151;font-weight:600">${esc(t.category)}</span>` : ''}
        ${t.subcategory ? `<span style="font-size:.9rem;color:#6b7280">› ${esc(t.subcategory)}</span>` : ''}
      </div>
      <p style="font-size:.85rem;color:#6b7280;margin-bottom:4px">Started: ${formatTimeShort(t.start_time)}</p>
      ${t.interruptions?.length ? `<p style="font-size:.85rem;color:#d97706;margin-bottom:4px">⚠️ ${t.interruptions.length} interruption(s) recorded</p>` : ''}
      ${t.notes ? `<p style="font-size:.85rem;color:#374151;margin-bottom:4px;font-style:italic">${esc(t.notes)}</p>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" style="flex:1" onclick="renderTaskActive()">▶ Resume</button>
        <button class="btn btn-secondary" style="flex:1" onclick="discardActiveTask()">✕ Abandon</button>
      </div>
    </div>` : `
    <button class="btn btn-primary btn-full" style="font-size:1.1rem;padding:18px" onclick="renderTaskStart()">
      ▶ Log Task
    </button>`}
    ${statsHTML}
    <div class="card" style="margin-top:16px">
      <div class="card-title">📋 Pending Tasks</div>
      ${state.pendingTaskLog ? `<p style="font-size:.85rem;color:#6b7280;margin-bottom:8px">Last logged: <strong>${state.pendingTaskLog.count}</strong> (${formatDateShort(state.pendingTaskLog.logged_at)} ${formatTimeShort(state.pendingTaskLog.logged_at)})</p>` : ''}
      ${state.recentHandledCount !== null ? `<p style="font-size:.85rem;color:#6b7280;margin-bottom:8px">Tasks handled (last 7 days): <strong>${state.recentHandledCount}</strong></p>` : ''}
      <div style="display:flex;gap:8px;align-items:center">
        <input id="pending-count-input" class="input" type="number" min="0" max="9999" placeholder="Enter count…" style="flex:1">
        <button class="btn btn-primary" onclick="doLogPendingCount()">Log</button>
      </div>
      <div id="pending-count-alerts" style="margin-top:8px"></div>
    </div>
  </div>
  ${renderBottomNav('home')}`;
}

async function renderHome() {
  stopTimer(); clearCharts(); state.currentView = 'home';
  pushHistory('home');
  app().innerHTML = renderHomeHTML();
  const [_activeTask, statsRes, pendingRes, recentRes] = await Promise.all([
    checkActiveTask(),
    fetch('/api/auth/stats', { credentials: 'same-origin' }).catch(() => null),
    fetch('/api/tasks/pending-count', { credentials: 'same-origin' }).catch(() => null),
    fetch('/api/tasks/recent-count', { credentials: 'same-origin' }).catch(() => null),
  ]);
  if (statsRes?.ok) state.appStats = await statsRes.json();
  if (pendingRes?.ok) state.pendingTaskLog = await pendingRes.json();
  if (recentRes?.ok) { const r = await recentRes.json(); state.recentHandledCount = r?.count ?? null; }
  if (state.activeTask) {
    await checkInactivityInterruption();
    updateLastActive();
    startActivityTracking();
  } else {
    stopActivityTracking();
  }
  if (state.currentView === 'home') app().innerHTML = renderHomeHTML();
}

function checkMidnightWarn() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 23 * 60 + 45;
}

async function discardActiveTask() {
  if (!state.activeTask) return;
  if (!confirm('Abandon this task? All data will be deleted.')) return;
  try {
    await api('PATCH', `/api/tasks/${state.activeTask.id}`, { status: 'discarded' });
    state.activeTask = null;
    stopActivityTracking();
    renderHome();
  } catch(e) { showAlert(e.message, 'error', 'home-alerts'); }
}

async function doLogPendingCount() {
  const input = document.getElementById('pending-count-input');
  const val = input?.value.trim();
  const count = parseInt(val, 10);
  if (val === '' || isNaN(count) || count < 0 || count > 9999) {
    showAlert('Please enter a valid number (0–9999).', 'error', 'pending-count-alerts'); return;
  }
  try {
    const d = await api('POST', '/api/tasks/pending-count', { count });
    if (!d) return;
    state.pendingTaskLog = d;
    if (input) input.value = '';
    showAlert('Pending task count logged.', 'success', 'pending-count-alerts');
  } catch(e) { showAlert(e.message, 'error', 'pending-count-alerts'); }
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function renderSettings() {
  stopTimer(); clearCharts(); state.currentView = 'settings';
  pushHistory('settings');
  const showInvite = state.registrationConfig?.userInvite !== 'disabled';
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <h1>⚙️ Settings</h1>
    </div>
    <div id="settings-alerts"></div>
    <div class="card">
      <p style="font-size:.9rem;color:#555;margin-bottom:14px">Logged in as: <strong>${esc(state.user?.username)}</strong></p>
      <div class="divider"></div>
      <button class="btn btn-outline btn-full" style="margin-bottom:10px" onclick="renderChangePassword()">🔑 Change Password</button>
      ${showInvite ? `<button class="btn btn-outline btn-full" style="margin-bottom:10px" id="invite-btn" onclick="doInviteUser()">👤 Invite a User</button>` : ''}
      <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="window.open('/policy','_blank')">📄 Data &amp; Use Policy</button>
      <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="window.open('/help','_blank')">❓ Help &amp; User Guide</button>
      <button class="btn btn-danger btn-full" style="margin-bottom:10px" onclick="doLogout()">🚪 Log Out</button>
      <div class="divider"></div>
      <button class="btn btn-danger btn-full" onclick="renderDeleteAccount()">🗑️ Delete My Account</button>
    </div>
  </div>
  ${renderBottomNav('settings')}`;
}

async function doLogout() {
  try { await api('POST', '/api/auth/logout'); } catch(e){}
  stopActivityTracking();
  state.user = null; state.activeTask = null; state.csrfToken = null;
  state.registrationConfig = null;
  try { await refreshCsrf(); } catch(e){}
  renderLogin();
}

async function doInviteUser() {
  const btn = document.getElementById('invite-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating invite…'; }
  try {
    const d = await api('POST', '/api/auth/invite', {});
    if (!d) { if (btn) { btn.disabled = false; btn.textContent = '👤 Invite a User'; } return; }
    if (btn) { btn.disabled = false; btn.textContent = '👤 Invite a User'; }
    showInviteResult(d.username, d.tempPassword, d.pendingActivation);
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '👤 Invite a User'; }
    showAlert(e.message, 'error', 'settings-alerts');
  }
}

function showInviteResult(username, tempPassword, pendingActivation) {
  const alertsEl = document.getElementById('settings-alerts');
  if (!alertsEl) return;
  const loginUrl = window.location.origin;
  const activationNote = pendingActivation ? '\n\n⏳ This account requires administrator activation. The user can log in and set their password, but will not have full access until an administrator activates their account.' : '';
  const shareMsg = `You have been invited to use Tasker.\n\nUsername: ${username}\nTemporary password: ${tempPassword}\nLog in at: ${loginUrl}\n\nYou will be asked to set a new password when you first log in.${activationNote}`;
  const div = document.createElement('div');
  div.className = 'alert alert-success';
  div.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  div.innerHTML = `
    <div><strong>Invite created</strong>${pendingActivation ? ' <span style="color:#d97706">(awaiting activation)</span>' : ''}</div>
    <div style="font-size:.85rem">Username: <strong>${esc(username)}</strong></div>
    <div style="display:flex;align-items:center;gap:8px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 12px">
      <code class="tmp-pw-code" style="flex:1;font-size:1rem;letter-spacing:.05em;word-break:break-all">${esc(tempPassword)}</code>
      <button class="btn btn-outline btn-sm tmp-pw-copy">📋 Copy</button>
    </div>
    ${pendingActivation ? '<div class="alert alert-warning" style="margin:0">⏳ The user can log in and change their password, but will see an "awaiting activation" page until an administrator activates their account.</div>' : ''}
    <div style="margin-top:4px">
      <p style="font-size:.8rem;color:#374151;margin:0 0 6px">Share via a <strong>secure channel</strong> (e.g. encrypted messaging or in person):</p>
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 12px">
        <pre class="tmp-share-msg" style="font-size:.78rem;color:#374151;white-space:pre-wrap;word-break:break-word;margin:0">${esc(shareMsg)}</pre>
      </div>
      <button class="btn btn-outline btn-sm tmp-share-copy" style="margin-top:6px;width:100%">📤 Copy Invite Message</button>
    </div>
    <p style="font-size:.8rem;color:#dc2626;margin:0">⚠️ Share credentials only through a secure channel. They will not be shown again.</p>
    <button class="btn btn-secondary btn-sm tmp-pw-dismiss">Dismiss</button>`;
  const codeEl = div.querySelector('.tmp-pw-code');
  div.querySelector('.tmp-pw-copy').addEventListener('click', function() {
    copyToClipboard(this, codeEl.textContent || '', '✓ Copied!');
  });
  div.querySelector('.tmp-share-copy').addEventListener('click', function() {
    copyToClipboard(this, shareMsg, '✓ Message copied!');
  });
  div.querySelector('.tmp-pw-dismiss').addEventListener('click', () => div.remove());
  alertsEl.prepend(div);
}

function renderDeleteAccount() {
  stopTimer(); clearCharts(); state.currentView = 'delete-account';
  pushHistory('delete-account');
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <button class="btn btn-secondary btn-sm" onclick="renderSettings()">← Back</button>
      <h1>Delete Account</h1>
    </div>
    <div class="alert alert-warning" style="margin-bottom:16px">⚠️ <strong>This cannot be undone.</strong> All your tasks and data will be permanently deleted.</div>
    <div id="da-alerts"></div>
    <div class="card">
      <div class="form-group">
        <label for="da-user">Type your username to confirm</label>
        <input id="da-user" class="input" type="text" autocomplete="off" autocapitalize="off" placeholder="${esc(state.user?.username)}">
      </div>
      <div class="form-group">
        <label for="da-pass">Enter your password</label>
        <div class="pw-field">
          <input id="da-pass" class="input" type="password" autocomplete="current-password">
          <button class="pw-toggle" type="button" onclick="togglePw('da-pass',this)">👁️</button>
        </div>
      </div>
      <button class="btn btn-danger btn-full" id="da-btn" onclick="doDeleteAccount()">🗑️ Permanently Delete My Account</button>
    </div>
  </div>`;
  const daEnter = e => { if (e.key === 'Enter') doDeleteAccount(); };
  document.getElementById('da-user').addEventListener('keydown', daEnter);
  document.getElementById('da-pass').addEventListener('keydown', daEnter);
}

async function doDeleteAccount() {
  const btn = document.getElementById('da-btn');
  const username = document.getElementById('da-user').value.trim();
  const password = document.getElementById('da-pass').value;
  if (!username || !password) { showAlert('Please enter your username and password.', 'error', 'da-alerts'); return; }
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await api('DELETE', '/api/auth/account', { username, password });
    state.user = null; state.activeTask = null; state.csrfToken = null;
    try { await refreshCsrf(); } catch(e){}
    renderLogin();
  } catch(e) {
    btn.disabled = false; btn.textContent = '🗑️ Permanently Delete My Account';
    showAlert(e.message, 'error', 'da-alerts');
  }
}

// ── TASK START ───────────────────────────────────────────────────────────────
function renderTaskStart() {
  stopTimer(); clearCharts(); state.currentView = 'task-start';
  pushHistory('task-start');
  state.taskForm = { is_duty: null };
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <button class="btn btn-secondary btn-sm" onclick="renderHome()">← Back</button>
      <h1>Log Task</h1>
    </div>
    <div id="ts-alerts"></div>
    <div class="form-group">
      <label>Task type</label>
      <div class="toggle-group">
        <button class="toggle-btn" id="tb-personal" onclick="setDuty(false)">👤 Personal</button>
        <button class="toggle-btn" id="tb-duty" onclick="setDuty(true)">🏥 My Group</button>
      </div>
    </div>
    ${buildDropdownGroup('category','Task From', state.dropdowns.category, 'ts-cat')}
    ${buildDropdownGroup('subcategory','Task Type', state.dropdowns.subcategory, 'ts-sub')}
    <div class="form-group">
      <label for="ts-assigned">Date assigned</label>
      <input id="ts-assigned" class="input" type="date" value="${new Date().toISOString().split('T')[0]}">
    </div>
    <button class="btn btn-primary btn-full" style="font-size:1.1rem;padding:18px" onclick="doStartTask()">▶ Start Timer</button>
  </div>`;
}

function setDuty(isDuty) {
  state.taskForm.is_duty = isDuty;
  document.getElementById('tb-duty').classList.toggle('active', isDuty);
  document.getElementById('tb-personal').classList.toggle('active', !isDuty);
}

function buildDropdownGroup(field, label, options, containerId) {
  const opts = options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  return `
  <div class="form-group" id="${containerId}-group">
    <label for="${containerId}-sel">${esc(label)}</label>
    <select id="${containerId}-sel" class="select" onchange="onDropdownChange('${containerId}','${field}')">
      <option value="">— Select —</option>
      ${opts}
      <option value="__new__">+ Add new option…</option>
    </select>
    <div id="${containerId}-new" style="display:none" class="add-new-row">
      <input id="${containerId}-new-input" class="input" type="text" placeholder="Type new ${label.toLowerCase()}…">
      <button class="btn btn-outline btn-sm" onclick="submitNewOption('${containerId}','${field}')">Submit</button>
    </div>
  </div>`;
}

function onDropdownChange(containerId, field) {
  const sel = document.getElementById(`${containerId}-sel`);
  const newDiv = document.getElementById(`${containerId}-new`);
  if (sel.value === '__new__') {
    newDiv.style.display = 'flex';
    sel.value = '';
  } else {
    newDiv.style.display = 'none';
    state.taskForm[field] = sel.value || null;
  }
}

async function submitNewOption(containerId, field) {
  const input = document.getElementById(`${containerId}-new-input`);
  const val = input.value.trim();
  if (!val) return;
  try {
    const d = await api('POST', '/api/dropdowns/propose', { field_name: field, value: val });
    if (!d) return;
    // Add to local dropdown
    const sel = document.getElementById(`${containerId}-sel`);
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = val + ' (pending)';
    sel.insertBefore(opt, sel.lastElementChild);
    sel.value = val;
    state.taskForm[field] = val;
    document.getElementById(`${containerId}-new`).style.display = 'none';
    showAlert('Option submitted for review.', 'success', 'ts-alerts');
  } catch(e) { showAlert(e.message, 'error', 'ts-alerts'); }
}

async function doStartTask() {
  const category = document.getElementById('ts-cat-sel')?.value || null;
  const subcategory = document.getElementById('ts-sub-sel')?.value || null;
  const assigned_date = document.getElementById('ts-assigned')?.value || new Date().toISOString().split('T')[0];
  const is_duty = state.taskForm.is_duty;
  if (!category) { showAlert('Please select a Task From.', 'error', 'ts-alerts'); return; }
  if (!subcategory) { showAlert('Please select a Task Type.', 'error', 'ts-alerts'); return; }
  if (is_duty === null) { showAlert('Please select My Group or Personal.', 'error', 'ts-alerts'); return; }
  try {
    const d = await api('POST', '/api/tasks/start', {
      is_duty, category: category || null, subcategory: subcategory || null,
      assigned_date,
      start_time: new Date().toISOString(),
    });
    if (!d) return;
    await checkActiveTask();
    renderTaskActive();
  } catch(e) { showAlert(e.message, 'error', 'ts-alerts'); }
}

// ── TASK ACTIVE ──────────────────────────────────────────────────────────────
function renderTaskActive() {
  stopTimer(); clearCharts(); state.currentView = 'task-active';
  const t = state.activeTask;
  if (!t) { renderHome(); return; }
  pushHistory('task-active');
  const midWarn = checkMidnightWarn();
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <h1>⏱️ Task Running</h1>
      <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? 'My Group' : 'Personal'}</span>
    </div>
    ${midWarn ? '<div class="midnight-warn">⚠️ Approaching midnight — your session will end at midnight!</div>' : ''}
    ${t.category ? `<p style="text-align:center;font-size:1rem;color:#374151;margin-bottom:4px">${esc(t.category)}${t.subcategory ? ' › ' + esc(t.subcategory) : ''}</p>` : ''}
    <div class="timer-display" id="timer-display">00:00:00</div>
    <div style="text-align:center;font-size:.85rem;color:#6b7280;margin-bottom:24px">
      Started: ${formatTimeShort(t.start_time)} 
      ${t.interruptions?.length ? ` · ${t.interruptions.length} interruption(s)` : ''}
    </div>
    <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="showInterruptModal()">⏸️ Interrupted</button>
    <button class="btn btn-primary btn-full" onclick="renderTaskEnd()">⏹️ End Task</button>
  </div>`;

  // Start live timer
  function tick() {
    const el = document.getElementById('timer-display');
    if (!el) { stopTimer(); return; }
    const totalSecs = calcElapsedSecs(t);
    el.textContent = formatHMS(totalSecs);
  }
  tick();
  state.timerInterval = setInterval(tick, 1000);
}

function calcElapsedSecs(task) {
  let ms = Date.now() - new Date(task.start_time).getTime();
  for (const i of (task.interruptions || [])) {
    if (i.start && i.end) ms -= new Date(i.end).getTime() - new Date(i.start).getTime();
  }
  return Math.max(0, Math.floor(ms / 1000));
}

function formatHMS(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}
function pad2(n) { return String(n).padStart(2,'0'); }

function formatTimeShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function formatDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── INTERRUPT MODAL ──────────────────────────────────────────────────────────
function showInterruptModal() {
  stopTimer();
  state.interruptStart = new Date().toISOString();
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'intr-modal';
  modal.innerHTML = `
  <div class="modal-sheet">
    <div class="modal-title">⏸️ Interrupted</div>
    <p style="font-size:.9rem;color:#555;margin-bottom:20px">What would you like to do?</p>
    <button class="btn btn-primary btn-full" style="margin-bottom:10px" onclick="resumeTask()">
      ▶ Resume — continue from here
    </button>
    <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="showManualInterruptForm()">
      📝 Enter interruption times manually
    </button>
    <button class="btn btn-danger btn-full" onclick="discardFromModal()">
      🗑 Discard this task
    </button>
  </div>`;
  document.body.appendChild(modal);
}

async function resumeTask(saveAutoInterrupt = true) {
  const m = document.getElementById('intr-modal');
  if (m) m.remove();
  const t = state.activeTask;
  if (saveAutoInterrupt && t && state.interruptStart) {
    const interruptions = [...(t.interruptions || []), {
      start: state.interruptStart,
      end: new Date().toISOString(),
    }];
    try {
      await api('PATCH', `/api/tasks/${t.id}`, { interruptions });
      t.interruptions = interruptions;
    } catch(e) {
      console.error('[Tasker] Failed to record interruption:', e);
    }
  }
  state.interruptStart = null;
  renderTaskActive();
}

function showManualInterruptForm() {
  const interruptStart = state.interruptStart || new Date().toISOString();
  const modal = document.getElementById('intr-modal');
  if (!modal) return;
  modal.querySelector('.modal-sheet').innerHTML = `
  <div class="modal-title">📝 Interruption Times</div>
  <p style="font-size:.85rem;color:#555;margin-bottom:16px">Enter when the interruption started and ended.</p>
  <div class="form-group">
    <label>Interruption started</label>
    <input id="intr-start" class="input" type="datetime-local" value="${formatDatetimeLocal(interruptStart)}">
  </div>
  <div class="form-group">
    <label>Interruption ended</label>
    <input id="intr-end" class="input" type="datetime-local" value="${formatDatetimeLocal(new Date().toISOString())}">
  </div>
  <button class="btn btn-primary btn-full" onclick="saveInterruption()">Save &amp; Resume</button>
  <button class="btn btn-secondary btn-full" style="margin-top:8px" onclick="resumeTask(false)">Cancel — resume without recording</button>`;
}

async function saveInterruption() {
  const start = document.getElementById('intr-start')?.value;
  const end = document.getElementById('intr-end')?.value;
  if (!start || !end) { alert('Please enter both times.'); return; }
  const t = state.activeTask;
  const interruptions = [...(t.interruptions || []), {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  }];
  try {
    await api('PATCH', `/api/tasks/${t.id}`, { interruptions });
    t.interruptions = interruptions;
    state.interruptStart = null;
    const m = document.getElementById('intr-modal');
    if (m) m.remove();
    renderTaskActive();
  } catch(e) { alert(e.message); }
}

async function discardFromModal() {
  if (!confirm('Discard this task? All data will be deleted.')) return;
  try {
    await api('PATCH', `/api/tasks/${state.activeTask.id}`, { status: 'discarded' });
    state.activeTask = null;
    state.interruptStart = null;
    stopActivityTracking();
    const m = document.getElementById('intr-modal');
    if (m) m.remove();
    renderHome();
  } catch(e) { alert(e.message); }
}

// ── TASK END ─────────────────────────────────────────────────────────────────
function renderTaskEnd() {
  stopTimer();
  const t = state.activeTask;
  if (!t) { renderHome(); return; }
  t.end_time = new Date().toISOString();
  renderTaskReview(t, false);
}

function renderTaskEdit(task) {
  stopTimer();
  state.editTask = task;
  renderTaskReview(task, true);
}

function renderTaskReview(t, isEdit) {
  clearCharts(); state.currentView = isEdit ? 'task-edit' : 'task-end';
  pushHistory(isEdit ? 'task-edit' : 'task-end');
  const interruptions = t.interruptions || [];
  const intrHtml = interruptions.length ? interruptions.map((i, idx) => `
  <div class="intr-item">
    <div>
      <div style="font-weight:600;font-size:.85rem">Interruption ${idx+1}</div>
      <div style="font-size:.8rem;color:#555">${formatTimeShort(i.start)} — ${formatTimeShort(i.end)}</div>
    </div>
    <button class="btn btn-danger btn-sm" onclick="removeInterruption(${idx})">✕</button>
  </div>`).join('') : '<p style="font-size:.85rem;color:#6b7280">No interruptions recorded.</p>';

  const taskSummaryHtml = !isEdit ? `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid #e5e7eb;margin-bottom:4px">
        <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? '🏥 My Group' : '👤 Personal'}</span>
        ${t.category ? `<span style="font-weight:600;color:#374151">${esc(t.category)}</span>` : ''}
        ${t.subcategory ? `<span style="color:#6b7280">›</span><span style="color:#374151">${esc(t.subcategory)}</span>` : ''}
      </div>` : `
      <div class="form-group">
        <label>Task type</label>
        <div class="toggle-group">
          <button class="toggle-btn ${t.is_duty ? 'active' : ''}" id="te-duty" onclick="setEditDuty(true)">🏥 My Group</button>
          <button class="toggle-btn ${!t.is_duty ? 'active' : ''}" id="te-personal" onclick="setEditDuty(false)">👤 Personal</button>
        </div>
      </div>
      ${buildReviewDropdown('category', 'Task From', state.dropdowns.category, t.category)}
      ${buildReviewDropdown('subcategory', 'Task Type', state.dropdowns.subcategory, t.subcategory)}`;

  const outcomeHtml = !isEdit
    ? buildReviewOutcomeGroup(state.dropdowns.outcome, t.outcome)
    : buildReviewDropdown('outcome', 'Outcome', state.dropdowns.outcome, t.outcome);

  const notesHtml = !isEdit ? `
      <details class="form-group">
        <summary style="cursor:pointer;font-weight:600;color:#374151;padding:4px 0;user-select:none">Notes (optional)</summary>
        <div style="margin-top:10px">
          <div class="warning-label">⚠️ DO NOT enter any patient names, initials, or identifiable information.</div>
          <textarea id="te-notes" class="textarea" style="margin-top:6px" placeholder="Optional notes (no patient data)">${esc(t.notes || '')}</textarea>
        </div>
      </details>` : `
      <div class="form-group">
        <div class="warning-label">⚠️ DO NOT enter any patient names, initials, or identifiable information.</div>
        <label for="te-notes">Notes</label>
        <textarea id="te-notes" class="textarea">${esc(t.notes || '')}</textarea>
      </div>`;

  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <button class="btn btn-secondary btn-sm" onclick="${isEdit ? 'renderAnalyticsSession()' : 'renderTaskActive()'}">← Back</button>
      <h1>${isEdit ? '✏️ Edit Task' : '⏹️ End Task'}</h1>
    </div>
    <div id="te-alerts"></div>
    <div class="card">
      ${taskSummaryHtml}
      ${outcomeHtml}
      <div class="form-group">
        <label for="te-start">Start time</label>
        <input id="te-start" class="input" type="datetime-local" value="${formatDatetimeLocal(t.start_time)}">
      </div>
      <div class="form-group">
        <label for="te-end">End time</label>
        <input id="te-end" class="input" type="datetime-local" value="${formatDatetimeLocal(t.end_time)}">
      </div>
      <div class="form-group">
        <label for="te-assigned">Date assigned</label>
        <input id="te-assigned" class="input" type="date" value="${t.assigned_date || new Date().toISOString().split('T')[0]}">
      </div>
      ${notesHtml}
    </div>
    <div class="card">
      <div class="card-title">Interruptions</div>
      <div id="intr-list">${intrHtml}</div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:80px">
      ${isEdit ? `
        <button class="btn btn-primary" style="flex:1" onclick="submitTaskReview(${t.id}, true)">💾 Save changes</button>
      ` : `
        <button class="btn btn-primary" style="flex:1" onclick="submitTaskReview(${t.id}, false, 'start')">➕ Submit &amp; add another</button>
        <button class="btn btn-secondary" style="flex:1" onclick="submitTaskReview(${t.id}, false, 'analytics')">📊 Submit &amp; analytics</button>
        <button class="btn btn-danger btn-sm" onclick="discardFromEnd(${t.id})">🗑</button>
      `}
    </div>
  </div>`;

  // store current form ref
  window._reviewTask = { ...t };
  window._reviewIsEdit = isEdit;
}

function buildReviewDropdown(field, label, options, current) {
  const opts = options.map(o => `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('');
  return `
  <div class="form-group">
    <label for="te-${field}">${esc(label)}</label>
    <select id="te-${field}" class="select">
      <option value="">— Select —</option>${opts}
    </select>
  </div>`;
}

function buildReviewOutcomeGroup(options, current) {
  const opts = options.map(o => `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('');
  return `
  <div class="form-group" id="te-out-group">
    <label for="te-outcome">Outcome</label>
    <select id="te-outcome" class="select" onchange="onOutcomeEndChange()">
      <option value="">— Select —</option>${opts}
      <option value="__new__">+ Add new outcome…</option>
    </select>
    <div id="te-out-new" style="display:none" class="add-new-row">
      <input id="te-out-new-input" class="input" type="text" placeholder="Type new outcome…">
      <button class="btn btn-outline btn-sm" onclick="submitNewOutcomeEnd()">Add</button>
    </div>
  </div>`;
}

function onOutcomeEndChange() {
  const sel = document.getElementById('te-outcome');
  const newDiv = document.getElementById('te-out-new');
  if (sel.value === '__new__') {
    newDiv.style.display = 'flex';
    sel.value = '';
  } else {
    newDiv.style.display = 'none';
  }
}

async function submitNewOutcomeEnd() {
  const input = document.getElementById('te-out-new-input');
  const val = input.value.trim();
  if (!val) return;
  try {
    await api('POST', '/api/dropdowns/propose', { field_name: 'outcome', value: val });
    const sel = document.getElementById('te-outcome');
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = val;
    sel.insertBefore(opt, sel.lastElementChild);
    sel.value = val;
    document.getElementById('te-out-new').style.display = 'none';
    input.value = '';
    showAlert('Outcome added — pending admin approval.', 'success', 'te-alerts');
  } catch(e) { showAlert(e.message, 'error', 'te-alerts'); }
}

function setEditDuty(isDuty) {
  document.getElementById('te-duty').classList.toggle('active', isDuty);
  document.getElementById('te-personal').classList.toggle('active', !isDuty);
  window._reviewTask.is_duty = isDuty;
}

function removeInterruption(idx) {
  const t = window._reviewTask;
  t.interruptions = (t.interruptions || []).filter((_, i) => i !== idx);
  renderTaskReview(t, window._reviewIsEdit);
}

async function submitTaskReview(taskId, isEdit, dest) {
  const t = window._reviewTask;
  const start = document.getElementById('te-start')?.value;
  const end = document.getElementById('te-end')?.value;
  if (!end) { showAlert('Please set an end time.', 'error', 'te-alerts'); return; }
  const outcome = document.getElementById('te-outcome')?.value || null;
  if (!outcome) { showAlert('Please select an Outcome.', 'error', 'te-alerts'); return; }
  const dutyEl = document.getElementById('te-duty');
  const categoryVal = document.getElementById('te-category')?.value || t.category || null;
  const subcategoryVal = document.getElementById('te-subcategory')?.value || t.subcategory || null;
  if (isEdit && !categoryVal) { showAlert('Please select a Task From.', 'error', 'te-alerts'); return; }
  if (isEdit && !subcategoryVal) { showAlert('Please select a Task Type.', 'error', 'te-alerts'); return; }
  const body = {
    status: 'completed',
    is_duty: dutyEl ? (dutyEl.classList.contains('active') ? 1 : 0) : (t.is_duty ? 1 : 0),
    category: categoryVal,
    subcategory: subcategoryVal,
    outcome,
    notes: document.getElementById('te-notes')?.value || null,
    start_time: start ? new Date(start).toISOString() : t.start_time,
    end_time: new Date(end).toISOString(),
    interruptions: t.interruptions || [],
    assigned_date: document.getElementById('te-assigned')?.value || t.assigned_date || null,
  };
  try {
    await api('PATCH', `/api/tasks/${taskId}`, body);
    state.activeTask = null;
    stopActivityTracking();
    await checkActiveTask();
    if (dest === 'start') {
      renderTaskStart();
    } else {
      showAlert('Task saved!', 'success', 'te-alerts');
      setTimeout(() => renderAnalyticsSession(), 800);
    }
  } catch(e) { showAlert(e.message, 'error', 'te-alerts'); }
}

async function discardFromEnd(taskId) {
  if (!confirm('Discard this task? All data will be deleted.')) return;
  try {
    await api('PATCH', `/api/tasks/${taskId}`, { status: 'discarded' });
    state.activeTask = null;
    stopActivityTracking();
    renderHome();
  } catch(e) { showAlert(e.message, 'error', 'te-alerts'); }
}

async function deleteTask(taskId) {
  if (!confirm('Permanently delete this task? This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/tasks/${taskId}`);
    if (state.currentView === 'analytics-history') renderAnalyticsHistory();
    else renderAnalyticsSession();
  } catch(e) { showAlert(e.message); }
}

async function clearAllTasks() {
  if (!confirm('Permanently delete all tasks? Active (in-progress) tasks will not be affected. This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/tasks');
    if (state.currentView === 'analytics-history') renderAnalyticsHistory();
    else renderAnalyticsSession();
  } catch(e) { showAlert(e.message); }
}

// ── ANALYTICS — SESSION ──────────────────────────────────────────────────────
async function renderAnalyticsSession() {
  stopTimer(); clearCharts(); state.currentView = 'analytics-session';
  pushHistory('analytics-session');
  app().innerHTML = `<div class="view"><p class="loading">Loading analytics…</p></div>`;
  try {
    const [d, pendingRes] = await Promise.all([
      api('GET', '/api/analytics/session'),
      fetch('/api/tasks/pending-count', { credentials: 'same-origin' }).catch(() => null),
    ]);
    if (!d) return;
    const pendingLog = pendingRes?.ok ? await pendingRes.json() : null;
    renderAnalyticsContent(d, 'session', pendingLog);
  } catch(e) { showAlert(e.message); }
}

async function renderAnalyticsHistory() {
  stopTimer(); clearCharts(); state.currentView = 'analytics-history';
  pushHistory('analytics-history');
  app().innerHTML = `<div class="view"><p class="loading">Loading history…</p></div>`;
  const params = buildHistoryParams();
  try {
    const [d, pendingRes] = await Promise.all([
      api('GET', '/api/analytics/history' + params),
      fetch('/api/tasks/pending-count', { credentials: 'same-origin' }).catch(() => null),
    ]);
    if (!d) return;
    const pendingLog = pendingRes?.ok ? await pendingRes.json() : null;
    renderAnalyticsContent(d, 'history', pendingLog);
  } catch(e) { showAlert(e.message); }
}

function buildHistoryParams() {
  const from = document.getElementById('h-from')?.value || '';
  const to = document.getElementById('h-to')?.value || '';
  const isDuty = document.getElementById('h-duty')?.value || '';
  const cat = document.getElementById('h-cat')?.value || '';
  const out = document.getElementById('h-out')?.value || '';
  const parts = [];
  if (from) parts.push('from=' + encodeURIComponent(from));
  if (to) parts.push('to=' + encodeURIComponent(to));
  if (isDuty) parts.push('is_duty=' + (isDuty === 'duty' ? 'true' : 'false'));
  if (cat) parts.push('category=' + encodeURIComponent(cat));
  if (out) parts.push('outcome=' + encodeURIComponent(out));
  return parts.length ? '?' + parts.join('&') : '';
}

function renderAnalyticsContent(data, mode, pendingLog) {
  const { tasks, summary: s } = data;
  const isHistory = mode === 'history';
  const pendingCount = pendingLog?.count ?? null;
  const pendingLabel = pendingLog
    ? `${pendingLog.count} <span style="font-size:.65rem;display:block;color:#6b7280;margin-top:2px">(${formatDateShort(pendingLog.logged_at)})</span>`
    : '—';

  const filterBar = isHistory ? `
  <div class="filter-bar" style="margin-bottom:16px">
    <div class="form-group" style="margin-bottom:0">
      <label>From date</label>
      <input id="h-from" class="input" type="date">
    </div>
    <div class="form-group" style="margin-bottom:0">
      <label>To date</label>
      <input id="h-to" class="input" type="date">
    </div>
    <div class="form-group" style="margin-bottom:0">
      <label>Type</label>
      <select id="h-duty" class="select">
        <option value="">All</option>
        <option value="duty">My Group only</option>
        <option value="personal">Personal only</option>
      </select>
    </div>
    <div class="form-group" style="margin-bottom:0">
      <label>Category</label>
      <select id="h-cat" class="select">
        <option value="">All</option>
        ${state.dropdowns.category.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div class="form-group" style="margin-bottom:0">
      <label>Outcome</label>
      <select id="h-out" class="select">
        <option value="">All</option>
        ${state.dropdowns.outcome.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-primary btn-full" onclick="renderAnalyticsHistory()">Apply Filters</button>
  </div>` : '';

  const taskCards = tasks.map(t => {
    const dur = calcDurMins(t);
    return `
    <div class="card task-card">
      <div class="task-card-row">
        <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? 'My Group' : 'Personal'}</span>
        <span class="task-card-meta">${formatTimeShort(t.start_time)} — ${formatTimeShort(t.end_time) || '?'} (${dur}m)</span>
      </div>
      <div class="task-card-title">${esc(t.category || 'Uncategorised')}${t.subcategory ? ' › ' + esc(t.subcategory) : ''}</div>
      ${t.outcome ? `<div class="task-card-meta">Outcome: ${esc(t.outcome)}</div>` : ''}
      ${t.interruptions?.length ? `<div class="task-card-meta">⚠️ ${t.interruptions.length} interruption(s)</div>` : ''}
      <div class="task-card-actions">
        <button class="btn btn-outline btn-sm" onclick="loadAndEditTask(${t.id})">✏️ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTask(${t.id})">🗑️ Delete</button>
      </div>
    </div>`;
  }).join('');

  const regressionNote = s.regression ? `
  <div class="alert alert-info" style="font-size:.85rem">
    📈 Trend: ${s.regression.slope > 0 ? '+' : ''}${s.regression.slope} tasks/day (R²=${s.regression.r2})
  </div>` : '';

  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <h1>${isHistory ? '📅 History' : '📊 Today\'s Session'}</h1>
    </div>
    <div class="retention-notice">⏳ Your data is automatically deleted after 30 days.</div>
    ${filterBar}
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-number">${s.total}</div><div class="stat-label">Total tasks</div></div>
      <div class="stat-card"><div class="stat-number">${s.totalMins}</div><div class="stat-label">Total mins</div></div>
      <div class="stat-card"><div class="stat-number">${s.dutyCount}</div><div class="stat-label">My Group tasks</div></div>
      <div class="stat-card"><div class="stat-number">${s.personalCount}</div><div class="stat-label">Personal</div></div>
      <div class="stat-card"><div class="stat-number">${s.totalInterruptions || 0}</div><div class="stat-label">Interruptions</div></div>
      <div class="stat-card"><div class="stat-number" style="font-size:${pendingCount !== null ? '2rem' : '1.5rem'}">${pendingLabel}</div><div class="stat-label">Pending tasks</div></div>
    </div>
    ${regressionNote}
    ${s.total > 0 ? `
    <div class="card">
      <div class="card-title">Time by Category</div>
      <div class="chart-container" style="height:240px"><canvas id="chart-cat"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">My Group vs Personal</div>
      <div class="chart-container" style="height:200px"><canvas id="chart-split"></canvas></div>
    </div>
    ${isHistory && s.dates?.length > 1 ? `
    <div class="card">
      <div class="card-title">Tasks Over Time</div>
      <div class="chart-container" style="height:220px"><canvas id="chart-trend"></canvas></div>
    </div>` : ''}
    ` : '<div class="card"><p style="color:#6b7280;text-align:center;padding:20px">No completed tasks yet.</p></div>'}
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      ${!isHistory ? '<button class="btn btn-outline" style="flex:1" onclick="renderAnalyticsHistory()">📅 Long-term History</button>' : ''}
      ${isMobileDevice() ? '<button class="btn btn-secondary" style="flex:1" onclick="downloadExport()">⬇️ Download Excel</button>' : ''}
    </div>
    <div class="section-heading">Tasks</div>
    ${tasks.length > 0 ? `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn btn-danger btn-sm" onclick="clearAllTasks()">🗑️ Clear All</button></div>` : ''}
    ${taskCards || '<p style="color:#6b7280;font-size:.9rem">No tasks found.</p>'}
  </div>
  ${renderBottomNav('analytics')}`;

  // Render charts
  if (s.total > 0) {
    // Category doughnut
    const catLabels = Object.keys(s.byCategory);
    const catMins = catLabels.map(k => s.byCategory[k].minutes);
    renderChart('chart-cat', 'doughnut', catLabels, [{ data: catMins, backgroundColor: COLORS }], { plugins: { legend: { position: 'bottom' } } });

    // My Group vs personal bar
    renderChart('chart-split', 'bar', ['My Group', 'Personal'],
      [{ label: 'Tasks', data: [s.dutyCount, s.personalCount], backgroundColor: ['#1a56db','#7c3aed'] }],
      { indexAxis: 'y', plugins: { legend: { display: false } } });

    // Trend line (history only)
    if (isHistory && s.dates?.length > 1) {
      const counts = s.dates.map(d => s.byDate[d].count);
      const datasets = [{ label: 'Tasks', data: counts, borderColor: '#1a56db', backgroundColor: 'rgba(26,86,219,.1)', tension: 0.3, fill: true }];
      if (s.regression) {
        const n = s.dates.length;
        const reg = s.dates.map((_, i) => Math.round((s.regression.slope * i + s.regression.intercept) * 10) / 10);
        datasets.push({ label: 'Trend', data: reg, borderColor: '#dc2626', borderDash: [5,5], pointRadius: 0, tension: 0 });
      }
      renderChart('chart-trend', 'line', s.dates, datasets, { plugins: { legend: { position: 'bottom' } } });
    }
  }
}

const COLORS = ['#1a56db','#7c3aed','#059669','#d97706','#dc2626','#0891b2','#65a30d','#9333ea'];

function renderChart(canvasId, type, labels, datasets, options) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  state.charts[canvasId] = new Chart(ctx, {
    type,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      ...options,
    },
  });
}

function calcDurMins(task) {
  if (!task.start_time || !task.end_time) return 0;
  let ms = new Date(task.end_time) - new Date(task.start_time);
  for (const i of (task.interruptions || [])) {
    if (i.start && i.end) ms -= new Date(i.end) - new Date(i.start);
  }
  return Math.max(0, Math.round(ms / 60000));
}

async function loadAndEditTask(taskId) {
  try {
    const d = await api('GET', `/api/tasks/${taskId}`);
    if (!d) return;
    renderTaskEdit(d.task);
  } catch(e) { showAlert(e.message); }
}

async function downloadExport() {
  if (!isMobileDevice()) {
    showAlert('Excel export is only available on mobile devices.', 'error');
    return;
  }
  window.location.href = '/api/analytics/export';
}

// ── ADMIN ────────────────────────────────────────────────────────────────────
async function renderAdmin() {
  stopTimer(); clearCharts(); state.currentView = 'admin';
  pushHistory('admin');
  app().innerHTML = `<div class="view"><p class="loading">Loading admin panel…</p></div>`;
  try {
    const [stats, users, dropOpts, settings, pendingUsers, awaitingUsers] = await Promise.all([
      api('GET', '/api/admin/stats'),
      api('GET', '/api/admin/users'),
      api('GET', '/api/dropdowns/admin/all'),
      api('GET', '/api/admin/settings'),
      api('GET', '/api/admin/pending-users'),
      api('GET', '/api/admin/awaiting-activation'),
    ]);
    if (!stats || !users || !dropOpts || !settings || !pendingUsers || !awaitingUsers) return;
    renderAdminContent(stats, users?.users || [], dropOpts?.options || [], settings, pendingUsers?.users || [], awaitingUsers?.users || []);
  } catch(e) {
    app().innerHTML = `<div class="view"><div id="admin-alerts"></div></div>`;
    showAlert(e.message, 'error', 'admin-alerts');
  }
}

function renderAdminContent(stats, users, dropOpts, settings, pendingUsers, awaitingUsers) {
  const pending = dropOpts.filter(o => !o.approved);
  const approved = dropOpts.filter(o => o.approved);
  const userCards = users.map(u => `
  <div class="card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <span style="font-weight:700">${esc(u.username)}</span>
        ${u.must_change_password ? '<span class="badge badge-warn" style="margin-left:6px">Temp pw</span>' : ''}
        ${u.is_locked ? '<span class="badge badge-danger" style="margin-left:6px">🔒 Locked</span>' : ''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${u.is_locked ? `<button class="btn btn-outline btn-sm" onclick="unlockUser(${u.id}, '${esc(u.username)}')">🔓 Unlock</button>` : ''}
        <button class="btn btn-outline btn-sm" onclick="resetUserPw(${u.id}, '${esc(u.username)}')">🔑 Reset</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${esc(u.username)}')">🗑</button>
      </div>
    </div>
  </div>`).join('');

  const dropByField = {};
  for (const o of approved) {
    if (!dropByField[o.field_name]) dropByField[o.field_name] = [];
    dropByField[o.field_name].push(o);
  }
  const dropFieldLabels = { category: 'Task from', subcategory: 'Task type', outcome: 'Outcome' };
  const dropSections = ['category','subcategory','outcome'].map(field => {
    const items = (dropByField[field] || []).map(o => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6">
      <span style="font-size:.9rem">${esc(o.value)}</span>
      <button class="btn btn-danger btn-sm" onclick="deleteDropdown(${o.id})">✕</button>
    </div>`).join('');
    return `
    <div class="card">
      <div class="card-title">${dropFieldLabels[field] || field.charAt(0).toUpperCase()+field.slice(1)} options</div>
      ${items || '<p style="font-size:.85rem;color:#6b7280">No options.</p>'}
      <div class="add-new-row" style="margin-top:10px">
        <input id="add-${field}" class="input" type="text" placeholder="New ${field}…">
        <button class="btn btn-outline btn-sm" onclick="addDropdown('${field}')">Add</button>
      </div>
    </div>`;
  }).join('');

  const pendingCards = pending.length ? pending.map(o => `
  <div class="card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <span style="font-size:.8rem;color:#6b7280">${esc(o.field_name)}</span>
        <span style="font-weight:700;margin-left:8px">${esc(o.value)}</span>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="approveDropdown(${o.id})">✓ Approve</button>
        <button class="btn btn-danger btn-sm" onclick="deleteDropdown(${o.id})">✗ Reject</button>
      </div>
    </div>
  </div>`).join('') : '<p style="font-size:.85rem;color:#6b7280">No pending proposals.</p>';

  const modeLabel = { disabled: 'Disabled', admin_approved: 'Administrator approval', auto: 'Automatic approval' };
  const modeOpts = (field, current) => ['disabled','admin_approved','auto'].map(m =>
    `<option value="${m}"${current===m?' selected':''}>${modeLabel[m]}</option>`
  ).join('');

  const pendingUserCards = pendingUsers.length ? pendingUsers.map(u => `
  <div class="card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <span style="font-weight:700">${esc(u.username)}</span>
        ${u.must_change_password ? '<span class="badge badge-warn" style="margin-left:6px">Temp pw</span>' : ''}
        <span style="font-size:.75rem;color:#6b7280;display:block;margin-top:2px">Registered ${new Date(u.created_at+'Z').toLocaleDateString()}</span>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="approvePendingUser(${u.id})">✓ Approve</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${esc(u.username)}')">✗ Reject</button>
      </div>
    </div>
  </div>`).join('') : '<p style="font-size:.85rem;color:#6b7280">No pending users.</p>';

  const awaitingUserCards = awaitingUsers.length ? awaitingUsers.map(u => `
  <div class="card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <span style="font-weight:700">${esc(u.username)}</span>
        ${u.must_change_password ? '<span class="badge badge-warn" style="margin-left:6px">Temp pw</span>' : ''}
        <span style="font-size:.75rem;color:#6b7280;display:block;margin-top:2px">Invited ${new Date(u.created_at+'Z').toLocaleDateString()}</span>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="activateUser(${u.id}, '${esc(u.username)}')">✓ Activate</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${esc(u.username)}')">✗ Reject</button>
      </div>
    </div>
  </div>`).join('') : '<p style="font-size:.85rem;color:#6b7280">No users awaiting activation.</p>';

  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <h1>🔐 Admin Panel</h1>
    </div>
    <div id="admin-alerts"></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-number">${stats?.userCount ?? '?'}</div><div class="stat-label">Registered users</div></div>
      <div class="stat-card"><div class="stat-number">${stats?.eventCount ?? '?'}</div><div class="stat-label">Events logged</div></div>
    </div>

    <div class="section-heading">Registration Settings</div>
    <div class="card">
      <div class="form-group">
        <label for="reg-self-mode" style="font-size:.9rem">Self-registration (from login page)</label>
        <select id="reg-self-mode" class="input" style="margin-top:4px">
          ${modeOpts('self_registration', settings?.selfRegistration)}
        </select>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label for="reg-invite-mode" style="font-size:.9rem">User invitations (by logged-in users)</label>
        <select id="reg-invite-mode" class="input" style="margin-top:4px">
          ${modeOpts('user_invite', settings?.userInvite)}
        </select>
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:12px" id="reg-settings-btn" onclick="saveRegistrationSettings()">💾 Save Settings</button>
    </div>

    <div class="section-heading">Pending User Approvals ${pendingUsers.length ? `<span class="badge badge-warn" style="margin-left:6px">${pendingUsers.length}</span>` : ''}</div>
    ${pendingUserCards}

    <div class="section-heading">Awaiting Activation ${awaitingUsers.length ? `<span class="badge badge-warn" style="margin-left:6px">${awaitingUsers.length}</span>` : ''}</div>
    ${awaitingUserCards}

    <div class="section-heading">Users</div>
    <button class="btn btn-primary btn-full" style="margin-bottom:14px" onclick="addUser()">➕ Add User</button>
    ${userCards || '<p style="font-size:.85rem;color:#6b7280;margin-bottom:14px">No users yet.</p>'}

    <div class="section-heading">Database</div>
    <div class="card">
      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="btn btn-outline btn-full" onclick="downloadBackup()">💾 Download Backup</button>
        <div>
          <label class="btn btn-secondary btn-full" style="cursor:pointer">
            📤 Restore from Backup
            <input type="file" accept=".db" style="display:none" onchange="uploadRestore(this)">
          </label>
          <p style="font-size:.75rem;color:#dc2626;margin-top:4px">⚠️ This replaces the current database immediately.</p>
        </div>
      </div>
    </div>

    <div class="section-heading">My Account</div>
    <div class="card">
      <button class="btn btn-outline btn-full" onclick="renderChangePassword()">🔑 Change My Password</button>
    </div>

    <div class="section-heading">Dropdown Options</div>
    ${dropSections}

    <div class="section-heading">Pending User Proposals</div>
    ${pendingCards}

    <div class="divider"></div>
    <button class="btn btn-secondary btn-full" style="margin-bottom:16px" onclick="doLogout()">🚪 Log Out</button>
    ${renderFooter()}
  </div>`;
}

function copyToClipboard(btn, text, successLabel) {
  navigator.clipboard?.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = successLabel;
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {});
}

function showTempPassword(label, username, tempPassword) {
  const alertsEl = document.getElementById('admin-alerts');
  if (!alertsEl) return;
  const loginUrl = window.location.origin;
  const shareMsg = `You have been invited to use Tasker.\n\nUsername: ${username}\nTemporary password: ${tempPassword}\nLog in at: ${loginUrl}\n\nYou will be asked to set a new password when you first log in.`;
  const div = document.createElement('div');
  div.className = 'alert alert-success';
  div.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  div.innerHTML = `
    <div><strong>${esc(label)}</strong></div>
    <div style="font-size:.85rem">Username: <strong>${esc(username)}</strong></div>
    <div style="display:flex;align-items:center;gap:8px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 12px">
      <code class="tmp-pw-code" style="flex:1;font-size:1rem;letter-spacing:.05em;word-break:break-all">${esc(tempPassword)}</code>
      <button class="btn btn-outline btn-sm tmp-pw-copy">📋 Copy</button>
    </div>
    <div style="margin-top:4px">
      <p style="font-size:.8rem;color:#374151;margin:0 0 6px">Share this invite message with the user via a <strong>secure channel</strong> (e.g. encrypted messaging or in person):</p>
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 12px">
        <pre class="tmp-share-msg" style="font-size:.78rem;color:#374151;white-space:pre-wrap;word-break:break-word;margin:0">${esc(shareMsg)}</pre>
      </div>
      <button class="btn btn-outline btn-sm tmp-share-copy" style="margin-top:6px;width:100%">📤 Copy Invite Message</button>
    </div>
    <p style="font-size:.8rem;color:#dc2626;margin:0">⚠️ Share credentials only through a secure channel. They will not be shown again.</p>
    <button class="btn btn-secondary btn-sm tmp-pw-dismiss">Dismiss</button>`;
  const codeEl = div.querySelector('.tmp-pw-code');
  div.querySelector('.tmp-pw-copy').addEventListener('click', function() {
    copyToClipboard(this, codeEl.textContent || '', '✓ Copied!');
  });
  div.querySelector('.tmp-share-copy').addEventListener('click', function() {
    copyToClipboard(this, shareMsg, '✓ Message copied!');
  });
  div.querySelector('.tmp-pw-dismiss').addEventListener('click', () => div.remove());
  alertsEl.prepend(div);
}

async function saveRegistrationSettings() {
  const btn = document.getElementById('reg-settings-btn');
  const selfRegistration = document.getElementById('reg-self-mode')?.value;
  const userInvite = document.getElementById('reg-invite-mode')?.value;
  if (!selfRegistration || !userInvite) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await api('POST', '/api/admin/settings', { selfRegistration, userInvite });
    showAlert('Registration settings saved.', 'success', 'admin-alerts');
  } catch(e) {
    showAlert(e.message, 'error', 'admin-alerts');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Settings'; }
  }
}

async function approvePendingUser(userId) {
  try {
    await api('POST', `/api/admin/users/${userId}/approve`, {});
    showAlert('User approved and activated.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function activateUser(userId, username) {
  if (!confirm(`Activate account for ${username}?`)) return;
  try {
    await api('POST', `/api/admin/users/${userId}/activate`, {});
    showAlert(`Account activated for ${username}.`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function addUser() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const d = await api('POST', '/api/admin/users', {});
    if (!d) { btn.disabled = false; btn.textContent = '➕ Add User'; return; }
    await renderAdmin();
    showTempPassword('New user created', d.username, d.tempPassword);
  } catch(e) {
    btn.disabled = false; btn.textContent = '➕ Add User';
    showAlert(e.message, 'error', 'admin-alerts');
  }
}

async function resetUserPw(userId, username) {
  if (!confirm(`Reset password for ${username}?`)) return;
  try {
    const d = await api('POST', `/api/admin/users/${userId}/reset-password`, {});
    if (!d) return;
    await renderAdmin();
    showTempPassword(`Temporary password for ${username}`, username, d.tempPassword);
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function unlockUser(userId, username) {
  if (!confirm(`Unlock account for ${username}?`)) return;
  try {
    await api('POST', `/api/admin/users/${userId}/unlock`, {});
    showAlert(`Account unlocked for ${username}.`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function deleteUser(userId, username) {
  if (!confirm(`Delete user ${username} and ALL their data? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/admin/users/${userId}`, {});
    showAlert(`User ${username} deleted.`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

function downloadBackup() {
  window.location.href = '/api/admin/backup';
}

async function uploadRestore(input) {
  if (!input.files?.length) return;
  if (!confirm('Replace the current database with this file? This cannot be undone.')) {
    input.value = ''; return;
  }
  const fd = new FormData();
  fd.append('db', input.files[0]);
  try {
    await api('POST', '/api/admin/restore', fd, true);
    showAlert('Database restored.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
  input.value = '';
}

async function addDropdown(field) {
  const input = document.getElementById(`add-${field}`);
  const val = input?.value.trim();
  if (!val) return;
  try {
    await api('POST', '/api/dropdowns/admin', { field_name: field, value: val });
    input.value = '';
    showAlert(`Added: ${val}`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function approveDropdown(id) {
  try {
    await api('POST', `/api/dropdowns/admin/${id}/approve`, {});
    showAlert('Option approved.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function deleteDropdown(id) {
  try {
    await api('DELETE', `/api/dropdowns/admin/${id}`, {});
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

// ── SPA back/forward navigation ───────────────────────────────────────────────
const HISTORY_RENDER_MAP = {
  'home':               () => renderHome(),
  'login':              () => renderLogin(),
  'register':           () => renderRegister(),
  'settings':           () => renderSettings(),
  'change-password':    () => renderChangePassword(),
  'delete-account':     () => renderDeleteAccount(),
  'task-start':         () => renderTaskStart(),
  'task-active':        () => { if (state.activeTask) renderTaskActive(); else renderHome(); },
  'task-end':           () => { if (state.activeTask) renderTaskEnd(); else renderHome(); },
  'task-edit':          () => { if (state.editTask) renderTaskEdit(state.editTask); else renderAnalyticsSession(); },
  'analytics-session':  () => renderAnalyticsSession(),
  'analytics-history':  () => renderAnalyticsHistory(),
  'admin':              () => renderAdmin(),
  'await-activation':   () => renderAwaitActivation(),
};

const AUTH_REQUIRED_VIEWS = new Set([
  'home', 'settings', 'change-password', 'delete-account',
  'task-start', 'task-active', 'task-end', 'task-edit',
  'analytics-session', 'analytics-history', 'admin', 'await-activation',
]);

window.addEventListener('popstate', async (e) => {
  const view = e.state?.view;
  if (!view) return;
  // Redirect to appropriate landing page if auth state doesn't match the view
  if ((view === 'login' || view === 'register') && state.user) {
    const targetView = state.user.isAdmin ? 'admin' : 'home';
    replaceHistory(targetView);
    await (state.user.isAdmin ? renderAdmin() : renderHome());
    return;
  }
  if (AUTH_REQUIRED_VIEWS.has(view) && !state.user) {
    replaceHistory('login');
    await renderLogin();
    return;
  }
  const renderer = HISTORY_RENDER_MAP[view];
  if (!renderer) return;
  _popstateActive = true;
  try {
    await renderer();
  } finally {
    _popstateActive = false;
  }
});

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loading-retry-btn')?.addEventListener('click', init);
  document.getElementById('loading-login-btn')?.addEventListener('click', renderLogin);
  init();
});

// ── Inactivity event hooks ────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => { updateLastActive(); });

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    updateLastActive();
  } else {
    if (state.user && !state.user.isAdmin && state.activeTask) {
      try {
        const interrupted = await checkInactivityInterruption();
        updateLastActive();
        if (interrupted) {
          if (state.currentView === 'home') {
            app().innerHTML = renderHomeHTML();
          } else if (state.currentView === 'task-active') {
            renderTaskActive();
          }
        }
      } catch(e) {
        console.error('[Tasker] Visibility change error:', e);
      }
    }
  }
});
