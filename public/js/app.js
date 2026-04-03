/* =====================================================================
   Tasker — Complete SPA (Vanilla JS, mobile-first, no frameworks)
   ===================================================================== */
'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  csrfToken: null,
  user: null,           // { username, isAdmin, mustChangePassword }
  activeTask: null,     // current in_progress task
  timerInterval: null,
  currentView: null,
  dropdowns: { category: [], subcategory: [], outcome: [] },
  taskForm: {},
  editTask: null,
  charts: {},
};

// ── DOM helpers ─────────────────────────────────────────────────────────────
const app = () => document.getElementById('app');
const esc = str => str == null ? '' : String(str)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#039;');

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
  if (res.status === 401) { await renderLogin(); return null; }
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
  try {
    setLoadingStatus('Fetching security token…');
    await refreshCsrf();

    setLoadingStatus('Checking session…');
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (me.ok) {
      state.user = await me.json();
      if (state.user.mustChangePassword) { renderChangePassword(); return; }

      setLoadingStatus('Loading dropdown options…');
      await loadDropdowns();

      setLoadingStatus('Checking active task…');
      await checkActiveTask();

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
  <p style="text-align:center;font-size:.75rem;color:#9ca3af;padding:8px 0 16px">v0.5.1 &nbsp;·&nbsp; <a href="/policy" target="_blank" style="color:#9ca3af">Privacy Policy</a></p>`;
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
async function renderLogin() {
  stopTimer(); clearCharts(); state.currentView = 'login';
  app().innerHTML = `
  <div class="view">
    <div style="text-align:center;padding-top:30px;margin-bottom:28px">
      <div style="font-size:3rem">📱</div>
      <h1 style="font-size:1.8rem;color:#1a56db;margin-top:8px">Tasker</h1>
      <p style="color:#6b7280;font-size:.9rem;margin-top:4px">Anonymous task logger</p>
    </div>
    <div id="login-alerts"></div>
    <div class="card">
      <div class="form-group">
        <label for="l-user">Username</label>
        <input id="l-user" class="input" type="text" autocomplete="username" autocapitalize="off" placeholder="e.g. CalmRiver">
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
      <button class="link-btn" onclick="renderRegister()">Don't have an account? Register</button>
      <a href="/policy" target="_blank" style="font-size:.85rem;color:#6b7280">Data &amp; Use Policy</a>
    </div>
    <p style="text-align:center;font-size:.75rem;color:#9ca3af;margin-top:24px;padding-bottom:16px">v0.5.1</p>
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
    state.user = { username, isAdmin: d.isAdmin, mustChangePassword: d.mustChangePassword };
    await refreshCsrf();
    if (d.mustChangePassword) { renderChangePassword(); return; }
    await loadDropdowns();
    await checkActiveTask();
    d.isAdmin ? renderAdmin() : renderHome();
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Log in';
    showAlert(e.message, 'error', 'login-alerts');
  }
}

// ── REGISTER ─────────────────────────────────────────────────────────────────
function renderRegister() {
  stopTimer(); clearCharts(); state.currentView = 'register';
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
    showRegisterSuccess(d.username);
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Register';
    showAlert(e.message, 'error', 'reg-alerts');
  }
}

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

// ── CHANGE PASSWORD ──────────────────────────────────────────────────────────
function renderChangePassword() {
  stopTimer(); clearCharts(); state.currentView = 'change-password';
  const isForced = state.user?.mustChangePassword;
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      ${!isForced ? '<button class="btn btn-secondary btn-sm" onclick="renderHome()">← Back</button>' : ''}
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
    await api('POST', '/api/auth/change-password', { currentPassword: oldPass, newPassword: newPass });
    if (state.user) state.user.mustChangePassword = false;
    await loadDropdowns();
    await checkActiveTask();
    showAlert('Password changed successfully!', 'success', 'cp-alerts');
    setTimeout(() => { state.user?.isAdmin ? renderAdmin() : renderHome(); }, 1000);
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Save new password';
    showAlert(e.message, 'error', 'cp-alerts');
  }
}

// ── HOME ─────────────────────────────────────────────────────────────────────
function renderHomeHTML() {
  const t = state.activeTask;
  const midnightWarn = checkMidnightWarn();
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
      <div class="card-title">⏸️ Active Task</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? 'Duty' : 'Personal'}</span>
        ${t.category ? `<span style="font-size:.9rem;color:#374151">${esc(t.category)}</span>` : ''}
      </div>
      <p style="font-size:.85rem;color:#6b7280">Started: ${formatTimeShort(t.start_time)}</p>
      <div class="task-card-actions">
        <button class="btn btn-primary" style="flex:1" onclick="renderTaskActive()">▶ Resume</button>
        <button class="btn btn-danger btn-sm" onclick="discardActiveTask()">🗑 Discard</button>
      </div>
    </div>` : `
    <button class="btn btn-primary btn-full" style="font-size:1.1rem;padding:18px" onclick="renderTaskStart()">
      ▶ Start New Task
    </button>`}
  </div>
  ${renderBottomNav('home')}`;
}

async function renderHome() {
  stopTimer(); clearCharts(); state.currentView = 'home';
  app().innerHTML = renderHomeHTML();
  await checkActiveTask();
  if (state.currentView === 'home') app().innerHTML = renderHomeHTML();
}

function checkMidnightWarn() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 23 * 60 + 45;
}

async function discardActiveTask() {
  if (!state.activeTask) return;
  if (!confirm('Discard this task? All data will be deleted.')) return;
  try {
    await api('PATCH', `/api/tasks/${state.activeTask.id}`, { status: 'discarded' });
    state.activeTask = null;
    renderHome();
  } catch(e) { showAlert(e.message, 'error', 'home-alerts'); }
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function renderSettings() {
  stopTimer(); clearCharts(); state.currentView = 'settings';
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <h1>⚙️ Settings</h1>
    </div>
    <div class="card">
      <p style="font-size:.9rem;color:#555;margin-bottom:14px">Logged in as: <strong>${esc(state.user?.username)}</strong></p>
      <div class="divider"></div>
      <button class="btn btn-outline btn-full" style="margin-bottom:10px" onclick="renderChangePassword()">🔑 Change Password</button>
      <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="window.open('/policy','_blank')">📄 Data &amp; Use Policy</button>
      <button class="btn btn-danger btn-full" style="margin-bottom:10px" onclick="doLogout()">🚪 Log Out</button>
      <div class="divider"></div>
      <button class="btn btn-danger btn-full" onclick="renderDeleteAccount()">🗑️ Delete My Account</button>
    </div>
  </div>
  ${renderBottomNav('settings')}`;
}

async function doLogout() {
  try { await api('POST', '/api/auth/logout'); } catch(e){}
  state.user = null; state.activeTask = null; state.csrfToken = null;
  try { await refreshCsrf(); } catch(e){}
  renderLogin();
}

function renderDeleteAccount() {
  stopTimer(); clearCharts(); state.currentView = 'delete-account';
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
  state.taskForm = { is_duty: true };
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <button class="btn btn-secondary btn-sm" onclick="renderHome()">← Back</button>
      <h1>Start Task</h1>
    </div>
    <div id="ts-alerts"></div>
    <div class="form-group">
      <label>Task type</label>
      <div class="toggle-group">
        <button class="toggle-btn active" id="tb-duty" onclick="setDuty(true)">🏥 Duty</button>
        <button class="toggle-btn" id="tb-personal" onclick="setDuty(false)">👤 Personal</button>
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
  const is_duty = state.taskForm.is_duty !== false;
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
  const midWarn = checkMidnightWarn();
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <h1>⏱️ Task Running</h1>
      <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? 'Duty' : 'Personal'}</span>
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
  const interruptStart = new Date().toISOString();
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
    <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="showManualInterruptForm('${interruptStart}')">
      📝 Enter interruption times manually
    </button>
    <button class="btn btn-danger btn-full" onclick="discardFromModal()">
      🗑 Discard this task
    </button>
  </div>`;
  document.body.appendChild(modal);
}

function resumeTask() {
  const m = document.getElementById('intr-modal');
  if (m) m.remove();
  renderTaskActive();
}

function showManualInterruptForm(interruptStart) {
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
  <button class="btn btn-secondary btn-full" style="margin-top:8px" onclick="resumeTask()">Cancel — resume without recording</button>`;
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
        <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? '🏥 Duty' : '👤 Personal'}</span>
        ${t.category ? `<span style="font-weight:600;color:#374151">${esc(t.category)}</span>` : ''}
        ${t.subcategory ? `<span style="color:#6b7280">›</span><span style="color:#374151">${esc(t.subcategory)}</span>` : ''}
      </div>` : `
      <div class="form-group">
        <label>Task type</label>
        <div class="toggle-group">
          <button class="toggle-btn ${t.is_duty ? 'active' : ''}" id="te-duty" onclick="setEditDuty(true)">🏥 Duty</button>
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
        <button class="btn btn-secondary" style="flex:1" onclick="submitTaskReview(${t.id}, false, 'start')">➕ Submit &amp; add another</button>
        <button class="btn btn-primary" style="flex:1" onclick="submitTaskReview(${t.id}, false, 'analytics')">📊 Submit &amp; analytics</button>
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
  const dutyEl = document.getElementById('te-duty');
  const body = {
    status: 'completed',
    is_duty: dutyEl ? (dutyEl.classList.contains('active') ? 1 : 0) : (t.is_duty ? 1 : 0),
    category: document.getElementById('te-category')?.value || t.category || null,
    subcategory: document.getElementById('te-subcategory')?.value || t.subcategory || null,
    outcome: document.getElementById('te-outcome')?.value || null,
    notes: document.getElementById('te-notes')?.value || null,
    start_time: start ? new Date(start).toISOString() : t.start_time,
    end_time: new Date(end).toISOString(),
    interruptions: t.interruptions || [],
  };
  try {
    await api('PATCH', `/api/tasks/${taskId}`, body);
    state.activeTask = null;
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
    renderHome();
  } catch(e) { showAlert(e.message, 'error', 'te-alerts'); }
}

// ── ANALYTICS — SESSION ──────────────────────────────────────────────────────
async function renderAnalyticsSession() {
  stopTimer(); clearCharts(); state.currentView = 'analytics-session';
  app().innerHTML = `<div class="view"><p class="loading">Loading analytics…</p></div>`;
  try {
    const d = await api('GET', '/api/analytics/session');
    if (!d) return;
    renderAnalyticsContent(d, 'session');
  } catch(e) { showAlert(e.message); }
}

async function renderAnalyticsHistory() {
  stopTimer(); clearCharts(); state.currentView = 'analytics-history';
  app().innerHTML = `<div class="view"><p class="loading">Loading history…</p></div>`;
  const params = buildHistoryParams();
  try {
    const d = await api('GET', '/api/analytics/history' + params);
    if (!d) return;
    renderAnalyticsContent(d, 'history');
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

function renderAnalyticsContent(data, mode) {
  const { tasks, summary: s } = data;
  const isHistory = mode === 'history';

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
        <option value="duty">Duty only</option>
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
        <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? 'Duty' : 'Personal'}</span>
        <span class="task-card-meta">${formatTimeShort(t.start_time)} — ${formatTimeShort(t.end_time) || '?'} (${dur}m)</span>
      </div>
      <div class="task-card-title">${esc(t.category || 'Uncategorised')}${t.subcategory ? ' › ' + esc(t.subcategory) : ''}</div>
      ${t.outcome ? `<div class="task-card-meta">Outcome: ${esc(t.outcome)}</div>` : ''}
      <div class="task-card-actions">
        <button class="btn btn-outline btn-sm" onclick="loadAndEditTask(${t.id})">✏️ Edit</button>
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
      <div class="stat-card"><div class="stat-number">${s.dutyCount}</div><div class="stat-label">Duty tasks</div></div>
      <div class="stat-card"><div class="stat-number">${s.personalCount}</div><div class="stat-label">Personal</div></div>
    </div>
    ${regressionNote}
    ${s.total > 0 ? `
    <div class="card">
      <div class="card-title">Time by Category</div>
      <div class="chart-container" style="height:240px"><canvas id="chart-cat"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Duty vs Personal</div>
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
      <button class="btn btn-secondary" style="flex:1" onclick="downloadExport()">⬇️ Download Excel</button>
    </div>
    <div class="section-heading">Tasks</div>
    ${taskCards || '<p style="color:#6b7280;font-size:.9rem">No tasks found.</p>'}
  </div>
  ${renderBottomNav('analytics')}`;

  // Render charts
  if (s.total > 0) {
    // Category doughnut
    const catLabels = Object.keys(s.byCategory);
    const catMins = catLabels.map(k => s.byCategory[k].minutes);
    renderChart('chart-cat', 'doughnut', catLabels, [{ data: catMins, backgroundColor: COLORS }], { plugins: { legend: { position: 'bottom' } } });

    // Duty vs personal bar
    renderChart('chart-split', 'bar', ['Duty', 'Personal'],
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
  window.location.href = '/api/analytics/export';
}

// ── ADMIN ────────────────────────────────────────────────────────────────────
async function renderAdmin() {
  stopTimer(); clearCharts(); state.currentView = 'admin';
  app().innerHTML = `<div class="view"><p class="loading">Loading admin panel…</p></div>`;
  try {
    const [stats, users, dropOpts] = await Promise.all([
      api('GET', '/api/admin/stats'),
      api('GET', '/api/admin/users'),
      api('GET', '/api/dropdowns/admin/all'),
    ]);
    if (!stats || !users || !dropOpts) return;
    renderAdminContent(stats, users?.users || [], dropOpts?.options || []);
  } catch(e) {
    app().innerHTML = `<div class="view"><div id="admin-alerts"></div></div>`;
    showAlert(e.message, 'error', 'admin-alerts');
  }
}

function renderAdminContent(stats, users, dropOpts) {
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
  const dropSections = ['category','subcategory','outcome'].map(field => {
    const items = (dropByField[field] || []).map(o => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6">
      <span style="font-size:.9rem">${esc(o.value)}</span>
      <button class="btn btn-danger btn-sm" onclick="deleteDropdown(${o.id})">✕</button>
    </div>`).join('');
    return `
    <div class="card">
      <div class="card-title">${field.charAt(0).toUpperCase()+field.slice(1)} options</div>
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

    <div class="section-heading">Dropdown Options</div>
    ${dropSections}

    <div class="section-heading">Pending User Proposals</div>
    ${pendingCards}

    <div class="divider"></div>
    <button class="btn btn-secondary btn-full" style="margin-bottom:16px" onclick="doLogout()">🚪 Log Out</button>
    <p style="text-align:center;font-size:.75rem;color:#9ca3af;padding-bottom:80px">v0.5.1 &nbsp;·&nbsp; <a href="/policy" target="_blank" style="color:#9ca3af">Privacy Policy</a></p>
  </div>`;
}

function showTempPassword(label, username, tempPassword) {
  const alertsEl = document.getElementById('admin-alerts');
  if (!alertsEl) return;
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
    <p style="font-size:.8rem;color:#374151;margin:0">Share this with the user securely. It will not be shown again.</p>
    <button class="btn btn-secondary btn-sm tmp-pw-dismiss">Dismiss</button>`;
  const copyBtn = div.querySelector('.tmp-pw-copy');
  const codeEl = div.querySelector('.tmp-pw-code');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard?.writeText(codeEl.textContent || '').then(() => { copyBtn.textContent = '✓ Copied!'; }).catch(() => {});
  });
  div.querySelector('.tmp-pw-dismiss').addEventListener('click', () => div.remove());
  alertsEl.prepend(div);
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

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loading-retry-btn')?.addEventListener('click', init);
  document.getElementById('loading-login-btn')?.addEventListener('click', renderLogin);
  init();
});
