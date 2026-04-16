/* =====================================================================
   Tasker — Complete SPA (Vanilla JS, mobile-first, no frameworks)
   ===================================================================== */
'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
const VERSION_CHECK_DEBOUNCE_MS = 60 * 1000; // 60 seconds — min gap between version checks
const VERSION_POLL_INTERVAL_MS  = 5 * 60 * 1000; // 5 minutes — background version poll

const state = {
  csrfToken: null,
  user: null,           // { username, isAdmin, mustChangePassword, userGroupId, userGroupName }
  registrationConfig: null, // { selfRegistration, userInvite }
  appStats: null,       // { userCount, taskCount }
  activeTask: null,     // current in_progress task
  timerInterval: null,
  activityInterval: null,
  inactivityCheckInterval: null,
  versionPollInterval: null,
  interruptStart: null, // ISO string set when interrupt modal opens
  currentView: null,
  dropdowns: { category: [], subcategory: [], outcome: [] },
  flagOptions: [],       // [{ id, value }]
  commonFields: { category: [], subcategory: [], outcome: [] },
  taskForm: {},
  lastUsedCombos: {},
  editTask: null,
  charts: {},
  pendingTaskLog: null,  // { count, logged_at } — most recent pending task snapshot
  recentHandledCount: null,  // number — tasks completed in the last 7 days
  pendingGraphDays: 7,          // null, 7, or 30 — currently shown pending graph
  analyticsQuickPeriod: 'today', // 'today', '7d', '30d', or null
  analyticsQuickFrom: '',        // date string set by quick filter
  analyticsQuickTo: '',          // date string set by quick filter
  analyticsFilterFrom: '',       // date string from advanced filter panel
  analyticsFilterTo: '',         // date string from advanced filter panel
  analyticsFilterDuty: '',       // duty filter from advanced filter panel
  analyticsFilterCategory: '',   // category filter from advanced filter panel
  analyticsFilterSubcategory: '', // subcategory filter from advanced filter panel
  analyticsFilterOutcome: '',    // outcome filter from advanced filter panel
  analyticsTasksExpanded: false, // whether task list is expanded in analytics
  analyticsFiltersExpanded: false, // whether advanced filters are expanded in analytics
  analyticsData: null,           // { data, mode, pendingLog } for re-rendering on toggle
  userMessages: [],              // [{ id, message, read, created_at }]
  notices: [],                   // [{ id, message, created_at }]
  noticesPanelOpen: false,       // whether Notices and Feedback panel is expanded
};

// ── History management ────────────────────────────────────────────────────────
let _popstateActive = false;
let _groupSelectionCb = null; // callback after group selection completes
let _myOptionsCb = null;      // callback after personal options step completes

function pushHistory(view) {
  if (_popstateActive || window.history.state?.view === view) return;
  window.history.pushState({ view }, '', window.location.pathname);
}

function replaceHistory(view) {
  window.history.replaceState({ view }, '', window.location.pathname);
}

// ── Asset version check ───────────────────────────────────────────────────────
let _lastVersionCheckAt = 0; // epoch ms — used to debounce foreground/poll checks

/** Clear all SW caches, SW registrations, and app localStorage, then reload. */
async function performAppUpdate() {
  const btn = document.querySelector('#update-banner button');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  // Capture the server's current version before wiping localStorage so we can
  // write it back immediately — preventing the banner from looping on reload.
  let latestVersion = null;
  try {
    const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
    if (r.ok) ({ version: latestVersion } = await r.json());
  } catch (e) { /* best-effort */ }
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(reg => reg.unregister()));
    }
    localStorage.clear();
    if (latestVersion) localStorage.setItem('tasker_app_version', latestVersion);
  } catch (e) { /* best-effort */ }
  window.location.reload();
}

/** Show a persistent top banner prompting the user to apply the update. */
function showUpdateBanner() {
  if (document.getElementById('update-banner')) return; // already visible
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML =
    '<span>A new version of Tasker is available.</span>' +
    '<button onclick="performAppUpdate()">🔄 App Update Needed</button>';
  document.body.prepend(banner);
}

async function checkAssetVersion() {
  _lastVersionCheckAt = Date.now();
  try {
    const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return false;
    const { version } = await r.json();
    const stored = localStorage.getItem('tasker_app_version');
    // First visit — no version stored yet. Silently record the current version
    // so the app loads normally, then return false (no update required).
    if (stored === null) {
      localStorage.setItem('tasker_app_version', version);
      return false;
    }
    // Returning visitor whose stored version is outdated — show the update banner.
    if (stored !== version) {
      showUpdateBanner();
      return true;
    }
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
// Sanitise values used as HTML attribute identifiers (strip everything except a-z A-Z 0-9 - _)
const safeId = str => str == null ? '' : String(str).replace(/[^a-zA-Z0-9\-_]/g, '');

// ── Combobox (integrated searchable dropdown) ────────────────────────────────
let _comboOpenId = null;

/** Close all open combos except optionally one */
function closeAllCombos(exceptId) {
  if (_comboOpenId && _comboOpenId !== exceptId) {
    const p = document.getElementById(`${_comboOpenId}-panel`);
    const b = document.getElementById(`${_comboOpenId}-btn`);
    if (p) p.classList.remove('open');
    if (b) { b.classList.remove('open'); b.classList.remove('placeholder'); }
    _comboOpenId = null;
  }
}

function openCombo(id, field, hasNew) {
  closeAllCombos(id);
  const panel = document.getElementById(`${id}-panel`);
  const btn   = document.getElementById(`${id}-btn`);
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  if (isOpen) { closeCombo(id); return; }
  panel.classList.add('open');
  if (btn) btn.classList.add('open');
  _comboOpenId = id;
  renderComboOpts(id, field, hasNew, '');
  const search = document.getElementById(`${id}-search`);
  if (search) {
    search.value = '';
    // Only auto-focus search on non-touch devices to avoid triggering the
    // mobile soft keyboard when the user merely opens a dropdown.
    if ((navigator.maxTouchPoints ?? 0) === 0) setTimeout(() => search.focus(), 30);
  }
  // Scroll the last-used (highlighted) option into view if present.
  // Small delay ensures the opts container has been rendered before scrolling.
  setTimeout(() => {
    const recent = document.querySelector(`#${id}-opts .combo-recent`);
    if (recent) recent.scrollIntoView({ block: 'nearest' });
  }, 20);
}

function closeCombo(id) {
  const panel = document.getElementById(`${id}-panel`);
  const btn   = document.getElementById(`${id}-btn`);
  if (panel) panel.classList.remove('open');
  if (btn) btn.classList.remove('open');
  if (_comboOpenId === id) _comboOpenId = null;
}

function renderComboOpts(id, field, hasNew, query) {
  const container = document.getElementById(`${id}-opts`);
  if (!container) return;
  const all = state.dropdowns[field] || [];
  const filtered = query ? all.filter(o => o.toLowerCase().includes(query.toLowerCase())) : all;
  const sid = safeId(id);
  const sfield = safeId(field);
  const lastUsed = state.lastUsedCombos[field] || null;
  let html = '';
  if (filtered.length === 0 && !hasNew) {
    html = `<div class="combo-opt combo-empty">No matching options</div>`;
  } else {
    html = filtered.map((o,i) => {
      const isRecent = lastUsed && o === lastUsed;
      return `<div class="combo-opt${isRecent ? ' combo-recent' : ''}" data-idx="${i}" onmousedown="selectComboOpt('${sid}','${sfield}','${esc(o)}')">${esc(o)}</div>`;
    }).join('');
  }
  if (hasNew) html += `<div class="combo-opt combo-new" onmousedown="comboAddNew('${sid}','${sfield}')">+ Add new option…</div>`;
  container.innerHTML = html;
}

function filterCombo(id, field, hasNew) {
  const search = document.getElementById(`${id}-search`);
  renderComboOpts(id, field, hasNew, search ? search.value.trim() : '');
}

function selectComboOpt(id, field, value) {
  const hidden = document.getElementById(`${id}-sel`);
  const btn    = document.getElementById(`${id}-btn`);
  if (hidden) hidden.value = value;
  if (btn) { btn.textContent = value; btn.classList.remove('placeholder'); }
  state.taskForm[field] = value;
  closeCombo(id);
  // hide add-new row if it was open
  const newDiv = document.getElementById(`${id}-new`);
  if (newDiv) newDiv.style.display = 'none';
}

function clearComboSelection(id, field, label) {
  const hidden = document.getElementById(`${id}-sel`);
  const btn    = document.getElementById(`${id}-btn`);
  if (hidden) hidden.value = '';
  if (btn) { btn.textContent = `— Select ${label} —`; btn.classList.add('placeholder'); }
  state.taskForm[field] = null;
}

function comboAddNew(id, field) {
  closeCombo(id);
  const newDiv = document.getElementById(`${id}-new`);
  if (newDiv) { newDiv.style.display = 'flex'; document.getElementById(`${id}-new-input`)?.focus(); }
}

function comboKeydown(ev, id, field, hasNew) {
  const opts = document.querySelectorAll(`#${id}-opts .combo-opt:not(.combo-empty)`);
  const active = document.querySelector(`#${id}-opts .combo-active`);
  let idx = active ? Array.from(opts).indexOf(active) : -1;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    idx = Math.min(idx + 1, opts.length - 1);
    opts.forEach((o, i) => o.classList.toggle('combo-active', i === idx));
    opts[idx]?.scrollIntoView({ block: 'nearest' });
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    idx = Math.max(idx - 1, 0);
    opts.forEach((o, i) => o.classList.toggle('combo-active', i === idx));
    opts[idx]?.scrollIntoView({ block: 'nearest' });
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    if (active) active.dispatchEvent(new MouseEvent('mousedown'));
    else closeCombo(id);
  } else if (ev.key === 'Escape') {
    closeCombo(id);
  }
}

// Close combo on outside click
document.addEventListener('mousedown', (e) => {
  if (!_comboOpenId) return;
  const wrap = document.getElementById(`${_comboOpenId}-wrap`);
  if (wrap && !wrap.contains(e.target)) closeCombo(_comboOpenId);
});

/** Build HTML for an integrated searchable combobox */
function buildComboBox(field, label, options, id, hasNew, current) {
  const displayValue = current || '';
  const sid = safeId(id);
  const sfield = safeId(field);
  return `
  <div class="form-group" id="${sid}-group">
    <label>${esc(label)}</label>
    <div class="combo-wrap" id="${sid}-wrap">
      <button type="button" id="${sid}-btn"
              class="combo-btn${displayValue ? '' : ' placeholder'}"
              onclick="openCombo('${sid}','${sfield}',${hasNew ? 'true' : 'false'})"
              aria-haspopup="listbox" aria-expanded="false">
        ${displayValue ? esc(displayValue) : `— Select ${esc(label)} —`}
      </button>
      <div class="combo-panel" id="${sid}-panel" role="listbox">
        <input class="combo-search" id="${sid}-search" type="text" autocomplete="off"
               placeholder="Search…"
               oninput="filterCombo('${sid}','${sfield}',${hasNew ? 'true' : 'false'})"
               onkeydown="comboKeydown(event,'${sid}','${sfield}',${hasNew ? 'true' : 'false'})">
        <div class="combo-opts" id="${sid}-opts"></div>
      </div>
      <input type="hidden" id="${sid}-sel" value="${esc(displayValue)}">
    </div>
    ${hasNew ? `<div id="${sid}-new" style="display:none" class="add-new-row">
      <input id="${sid}-new-input" class="input" type="text" placeholder="Type new ${esc(label.toLowerCase())}…">
      <button class="btn btn-outline btn-sm" onclick="submitNewOption('${sid}','${sfield}')">Submit</button>
    </div>` : ''}
  </div>`;
}

function isMobileDevice() {
  return /Mobile|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getAppVersion() {
  return localStorage.getItem('tasker_app_version') || '…';
}

function renderFooter() {
  const v = getAppVersion();
  return `<p style="text-align:center;font-size:.75rem;color:#9ca3af;padding:8px 0 16px">v${v} &nbsp;·&nbsp; <a href="/policy" style="color:#9ca3af">Privacy Policy</a> &nbsp;·&nbsp; <a href="/dpia" style="color:#9ca3af">DPIA</a> &nbsp;·&nbsp; <a href="/help" style="color:#9ca3af">Help</a><br>© J Rowson ${new Date().getFullYear()} | <a href="https://jahosi.co.uk" target="_blank" style="color:#9ca3af">jahosi.co.uk</a></p>`;
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
  // Poll for new app versions every 5 minutes while the user is logged in.
  state.versionPollInterval = setInterval(() => checkAssetVersion(), VERSION_POLL_INTERVAL_MS);
}

function stopActivityTracking() {
  if (state.activityInterval) { clearInterval(state.activityInterval); state.activityInterval = null; }
  if (state.inactivityCheckInterval) { clearInterval(state.inactivityCheckInterval); state.inactivityCheckInterval = null; }
  if (state.versionPollInterval) { clearInterval(state.versionPollInterval); state.versionPollInterval = null; }
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
  if ('caches' in window) {
    try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch(e) {}
  }
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
  if (await checkAssetVersion()) {
    // A new version has been deployed — show banner above.
    // Replace loading status with clear instruction so the user knows what to do.
    setLoadingStatus('Update available — tap "🔄 App Update Needed" above to apply it.');
    return;
  }

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
    const [cats, subs, outs, flagOpts, common] = await Promise.all([
      api('GET','/api/dropdowns/category'),
      api('GET','/api/dropdowns/subcategory'),
      api('GET','/api/dropdowns/outcome'),
      api('GET','/api/flags'),
      api('GET','/api/tasks/common-fields'),
    ]);
    if (cats) state.dropdowns.category = cats.options;
    if (subs) state.dropdowns.subcategory = subs.options;
    if (outs) state.dropdowns.outcome = outs.options;
    if (flagOpts) state.flagOptions = flagOpts.options || [];
    if (common) state.commonFields = common;
  } catch(e) {}
}

async function loadNoticesAndMessages() {
  try {
    const [noticesRes, msgsRes] = await Promise.all([
      fetch('/api/auth/notices', { credentials: 'same-origin' }).catch(() => null),
      fetch('/api/messages', { credentials: 'same-origin' }).catch(() => null),
    ]);
    if (noticesRes?.ok) { const d = await noticesRes.json(); state.notices = d.notices || []; }
    if (msgsRes?.ok) { const d = await msgsRes.json(); state.userMessages = d.messages || []; }
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
  </nav>`;
}

// ── STATS CARDS ──────────────────────────────────────────────────────────────
function renderStatsCards(stats, marginTop = '20px') {
  if (!stats) return '';
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:${marginTop}">
      <div class="stat-card"><div class="stat-number">${stats.userCount}</div><div class="stat-label">Registered users</div></div>
      <div class="stat-card"><div class="stat-number">${stats.taskCount}</div><div class="stat-label">Tasks logged</div></div>
    </div>`;
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
async function renderLogin() {
  stopTimer(); stopActivityTracking(); clearCharts(); state.currentView = 'login';
  replaceHistory('login');
  // Force a refresh of the local SW cache so stale assets can't cause CSRF token mismatches
  if ('caches' in window) {
    try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch(e) {}
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
      <a href="/policy" style="font-size:.85rem;color:#6b7280">Data &amp; Use Policy</a>
      <a href="/guide" style="font-size:.85rem;color:#1a56db;font-weight:600">📖 Quick Start Guide</a>
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
    if (d.requires2fa) {
      state._pending2faUsername = username;
      await refreshCsrf();
      render2faVerify();
      return;
    }
    // Clear all SW caches on login so every authenticated session starts with
    // the most recent assets, regardless of what the service worker had cached.
    if ('caches' in window) {
      try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch(e) {}
    }
    state.user = { username, isAdmin: d.isAdmin, mustChangePassword: d.mustChangePassword, pendingActivation: d.pendingActivation, userGroupId: d.userGroupId ?? null, userGroupName: d.userGroupName ?? null };
    await refreshCsrf();
    if (d.mustChangePassword) { renderChangePassword(); return; }
    if (d.pendingActivation) { renderAwaitActivation(); return; }
    await loadDropdowns();
    await checkActiveTask();
    startActivityTracking();
    renderPrivacySplash(async () => {
      if (d.isAdmin) { renderAdmin(); return; }
      if (!state.user.userGroupId) { await renderGroupSelection(() => renderHome()); return; }
      renderHome();
    });
  } catch(e) {
    if (/invalid csrf token/i.test(e.message)) {
      showAlert('Login expired, refreshing…', 'info', 'login-alerts');
      setTimeout(() => location.reload(), 2000);
      return;
    }
    btn.disabled = false; btn.textContent = 'Log in';
    showAlert(e.message, 'error', 'login-alerts');
  }
}

async function render2faVerify() {
  state.currentView = 'login';
  replaceHistory('login');
  app().innerHTML = `
  <div class="view" style="min-height:auto;padding-bottom:24px">
    <div style="text-align:center;padding-top:30px;margin-bottom:28px">
      <div style="font-size:3rem">🔐</div>
      <h1 style="font-size:1.8rem;color:#1a56db;margin-top:8px">Two-Factor Authentication</h1>
      <p style="color:#6b7280;font-size:.9rem;margin-top:4px">A verification code has been sent to your registered admin email address.</p>
    </div>
    <div id="tfa-alerts"></div>
    <div class="card">
      <div class="form-group">
        <label for="tfa-code">Verification Code</label>
        <input id="tfa-code" class="input" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" style="letter-spacing:.2em;font-size:1.2rem;text-align:center">
      </div>
      <button class="btn btn-primary btn-full" id="tfa-btn" onclick="do2faVerify()" style="margin-top:10px">✅ Verify</button>
      <button class="btn btn-outline btn-full" id="tfa-resend-btn" onclick="do2faResend()" style="margin-top:8px">🔄 Resend Code</button>
    </div>
    <div style="text-align:center;margin-top:16px">
      <button class="link-btn" onclick="renderLogin()">← Back to Login</button>
    </div>
    ${renderFooter()}
  </div>`;
  document.getElementById('tfa-code').addEventListener('keydown', e => { if (e.key === 'Enter') do2faVerify(); });
}

async function do2faVerify() {
  const btn = document.getElementById('tfa-btn');
  const code = (document.getElementById('tfa-code').value || '').trim();
  if (!code) { showAlert('Enter the verification code.', 'error', 'tfa-alerts'); return; }
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const d = await api('POST', '/api/auth/verify-2fa', { code });
    if (!d) { btn.disabled = false; btn.textContent = '✅ Verify'; return; }
    if ('caches' in window) {
      try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch(e) {}
    }
    const username = state._pending2faUsername || 'admin';
    delete state._pending2faUsername;
    state.user = { username, isAdmin: d.isAdmin, mustChangePassword: d.mustChangePassword, pendingActivation: d.pendingActivation, userGroupId: d.userGroupId ?? null, userGroupName: d.userGroupName ?? null };
    await refreshCsrf();
    if (d.mustChangePassword) { renderChangePassword(); return; }
    if (d.pendingActivation) { renderAwaitActivation(); return; }
    await loadDropdowns();
    await checkActiveTask();
    startActivityTracking();
    renderPrivacySplash(async () => {
      if (d.isAdmin) { renderAdmin(); return; }
      if (!state.user.userGroupId) { await renderGroupSelection(() => renderHome()); return; }
      renderHome();
    });
  } catch(e) {
    btn.disabled = false; btn.textContent = '✅ Verify';
    showAlert(e.message, 'error', 'tfa-alerts');
  }
}

async function do2faResend() {
  const btn = document.getElementById('tfa-resend-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await api('POST', '/api/auth/resend-2fa', {});
    showAlert('A new code has been sent to your admin email.', 'success', 'tfa-alerts');
  } catch(e) {
    showAlert(e.message, 'error', 'tfa-alerts');
  } finally {
    btn.disabled = false; btn.textContent = '🔄 Resend Code';
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
      <a href="/policy" style="color:#9ca3af">Data &amp; Use Policy</a>
      &nbsp;·&nbsp;
      <a href="/dpia" style="color:#9ca3af">Data Protection Impact Assessment</a>
    </p>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('splash-continue-btn').addEventListener('click', () => {
    overlay.remove();
    onContinue();
  });
}

// ── GROUP SELECTION ───────────────────────────────────────────────────────────
async function renderGroupSelection(onContinue) {
  _groupSelectionCb = onContinue;
  stopTimer(); clearCharts(); state.currentView = 'group-selection';
  replaceHistory('group-selection');
  app().innerHTML = `<div class="view"><p class="loading">Loading groups…</p></div>`;
  let groups = [];
  try {
    const d = await api('GET', '/api/auth/user-groups');
    groups = d?.groups || [];
  } catch(e) {}
  const groupOpts = groups.map(g => `
    <button class="card" id="gsel-${g.id}" onclick="selectGroupOption(${g.id})" style="padding:14px;cursor:pointer;border:2px solid #e5e7eb;margin-bottom:8px;width:100%;text-align:left;background:#fff;border-radius:8px">
      <span style="font-weight:600;font-size:1rem">${esc(g.name)}</span>
    </button>`).join('');
  app().innerHTML = `
  <div class="view">
    <h1 style="margin-bottom:8px;color:#1a56db">👥 Choose Your Group</h1>
    <p style="font-size:.9rem;color:#6b7280;margin-bottom:12px">
      Your group determines which task origin, type and outcome options appear in your dropdown lists.
      You can change this later in Settings.
    </p>
    <div class="alert alert-info" style="margin-bottom:16px;font-size:.85rem">
      🔒 <strong>Your privacy:</strong> Your group selection is used only to personalise your dropdown options and for aggregate audit purposes. It does not make your account identifiable and is not visible to administrators.
    </div>
    <div id="group-alerts"></div>
    ${groupOpts || '<div class="alert alert-info">No user groups have been set up yet. Ask your administrator.</div>'}
    <div style="display:flex;gap:10px;margin-top:8px">
      <button class="btn btn-primary btn-full" id="gsel-btn" onclick="doSetGroup()" ${groups.length ? '' : 'disabled'}>✓ Continue with selected group</button>
    </div>
    <button class="btn btn-secondary btn-full" style="margin-top:8px" onclick="skipGroupSelection()">Skip for now</button>
    <div style="margin-top:20px;border-top:1px solid #e5e7eb;padding-top:16px">
      <p style="font-size:.85rem;color:#6b7280;margin-bottom:6px">Don't see your group? Suggest one for admin review.</p>
      <div class="alert alert-warning" style="font-size:.8rem;margin-bottom:8px">⚠️ Do not include any patient, staff, location, or other personally identifiable information in group names.</div>
      <div class="add-new-row">
        <input id="gsel-propose-input" class="input" style="flex:1" type="text" maxlength="100" placeholder="Suggest a group name…">
        <button class="btn btn-outline btn-sm" onclick="proposeGroupName('group-alerts')">Suggest</button>
      </div>
    </div>
  </div>`;
}

function selectGroupOption(id) {
  document.querySelectorAll('[id^="gsel-"]').forEach(el => {
    el.style.borderColor = el.id === `gsel-${id}` ? '#1a56db' : '#e5e7eb';
    el.style.background = el.id === `gsel-${id}` ? '#eff6ff' : '';
  });
  state._pendingGroupId = id;
}

async function doSetGroup() {
  const groupId = state._pendingGroupId ?? null;
  if (!groupId) { showAlert('Please select a group.', 'error', 'group-alerts'); return; }
  const btn = document.getElementById('gsel-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await api('POST', '/api/auth/set-group', { groupId });
    if (state.user) {
      const groupEl = document.getElementById(`gsel-${groupId}`);
      state.user.userGroupId = groupId;
      state.user.userGroupName = groupEl?.querySelector('span')?.textContent || null;
    }
    state._pendingGroupId = null;
    await loadDropdowns();
    // Show personal options customisation step
    const onContinue = () => {
      if (_groupSelectionCb) { const cb = _groupSelectionCb; _groupSelectionCb = null; cb(); }
    };
    await renderMyOptionsStep(state.user?.userGroupName || 'your group', onContinue);
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Continue with selected group'; }
    showAlert(e.message, 'error', 'group-alerts');
  }
}

function skipGroupSelection() {
  state._pendingGroupId = null;
  if (_groupSelectionCb) { const cb = _groupSelectionCb; _groupSelectionCb = null; cb(); }
}

async function proposeGroupName(alertContainerId) {
  const input = document.getElementById('gsel-propose-input');
  const val = (input?.value || '').trim();
  if (!val) return;
  try {
    const d = await api('POST', '/api/auth/propose-group', { name: val });
    if (input) input.value = '';
    showAlert(d?.message || 'Group suggestion submitted for admin review.', 'success', alertContainerId);
  } catch(e) { showAlert(e.message, 'error', alertContainerId); }
}

// ── MY OPTIONS (personal dropdown customisation) ──────────────────────────────
async function _loadAndShowMyOptions(groupName, onContinue, historyEntry) {
  _myOptionsCb = onContinue;
  state.currentView = 'my-options';
  if (historyEntry === 'replace') replaceHistory('my-options');
  else if (historyEntry === 'push') pushHistory('my-options');
  app().innerHTML = `<div class="view"><p class="loading">Loading options…</p></div>`;
  let options = [];
  try {
    const d = await api('GET', '/api/auth/my-options');
    options = d?.options || [];
  } catch(e) {}
  app().innerHTML = buildMyOptionsPage(groupName, options);
}

async function renderMyOptionsStep(groupName, onContinue) {
  await _loadAndShowMyOptions(groupName, onContinue, 'replace');
}

async function openMyOptionsModal() {
  await _loadAndShowMyOptions(
    state.user?.userGroupName || 'your group',
    () => renderSettings(),
    'push'
  );
}

function buildMyOptionsPage(groupName, options) {
  const byField = {};
  for (const o of options) {
    if (!byField[o.field_name]) byField[o.field_name] = [];
    byField[o.field_name].push(o);
  }
  const fieldLabels = { category: 'Task from', subcategory: 'Task type', outcome: 'Outcome' };
  const sections = ['category', 'subcategory', 'outcome'].map(field => {
    const opts = (byField[field] || []).map(o => `
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f3f4f6;cursor:pointer">
        <input type="checkbox" name="my-opt" value="${o.id}" ${o.assigned ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0">
        <span style="font-size:.9rem">${esc(o.value)}</span>
      </label>`).join('');
    return `<div style="margin-bottom:16px">
      <div style="font-weight:700;color:#374151;font-size:.9rem;margin-bottom:4px">${fieldLabels[field]}</div>
      ${opts || '<p style="font-size:.85rem;color:#6b7280">No options available</p>'}
      <div class="add-new-row" style="margin-top:8px">
        <input id="co-new-${field}" class="input" style="flex:1" type="text" maxlength="100" placeholder="Suggest new ${fieldLabels[field].toLowerCase()}…">
        <button class="btn btn-outline btn-sm" onclick="proposeOptionFromCustomise('${field}')">Suggest</button>
      </div>
    </div>`;
  }).join('');
  return `
  <div class="view">
    <h1 style="margin-bottom:8px;color:#1a56db">⚙️ Customise My Options</h1>
    <p style="font-size:.9rem;color:#6b7280;margin-bottom:8px">
      These are the default options for the <strong>${esc(groupName)}</strong> group.
      Tick or untick to personalise your dropdown lists.
    </p>
    <div class="alert alert-warning" style="margin-bottom:16px;font-size:.82rem">
      ⚠️ When suggesting new options, do not include any patient, staff, location, or other personally identifiable information. Suggestions are reviewed by an administrator before becoming available.
    </div>
    <div id="myopts-alerts"></div>
    ${sections || '<p style="color:#6b7280">No options available.</p>'}
    <div id="myopts-propose-alerts"></div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">
      <button class="btn btn-primary btn-full" id="myopts-save-btn" onclick="doSaveMyOptions()">✓ Save and continue</button>
      <button class="btn btn-secondary btn-full" onclick="skipMyOptions()">Use defaults as-is</button>
    </div>
  </div>`;
}

async function doSaveMyOptions() {
  const checkboxes = document.querySelectorAll('input[name="my-opt"]:checked');
  const option_ids = Array.from(checkboxes).map(cb => Number(cb.value));
  const btn = document.getElementById('myopts-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await api('PUT', '/api/auth/my-options', { option_ids });
    await loadDropdowns();
    if (_myOptionsCb) { const cb = _myOptionsCb; _myOptionsCb = null; cb(); }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Save and continue'; }
    showAlert(e.message, 'error', 'myopts-alerts');
  }
}

function skipMyOptions() {
  if (_myOptionsCb) { const cb = _myOptionsCb; _myOptionsCb = null; cb(); }
}

async function proposeOptionFromCustomise(field) {
  const input = document.getElementById(`co-new-${field}`);
  const val = (input?.value || '').trim();
  if (!val) { showAlert('Please enter a value to suggest.', 'error', 'myopts-propose-alerts'); return; }
  try {
    const d = await api('POST', '/api/dropdowns/propose', { field_name: field, value: val });
    if (input) input.value = '';
    showAlert(`"${esc(val)}" submitted for admin review.`, 'success', 'myopts-propose-alerts');
  } catch(e) { showAlert(e.message, 'error', 'myopts-propose-alerts'); }
}

function setGroupFromSettings() {
  renderGroupSelection(async () => {
    // After group chosen + options customised, return to settings
    renderSettings();
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
          I have read the <a href="/policy">Data &amp; Use Policy</a> and 
          I understand I must <strong>never enter patient or identifiable information</strong>.
        </label>
      </div>
      <button class="btn btn-primary btn-full" id="r-btn" onclick="doRegister()">Register</button>
    </div>
    ${renderFooter()}
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
    ${renderFooter()}
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
    ${renderFooter()}
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

  // Notices and Feedback section (collapsible, unread badge via localStorage)
  const unreadNoticeCount = countUnreadNotices();
  const noticesPanelHtml = `
    <div class="card" style="margin-top:12px;border-left:4px solid #1a56db">
      <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer" onclick="toggleNoticesPanel()">
        <div class="card-title" style="color:#1a56db;margin:0">📢 Notices and Feedback${unreadNoticeCount > 0 ? ` <span class="badge badge-warn" style="margin-left:6px">${unreadNoticeCount}</span>` : ''}</div>
        <span style="font-size:.85rem;color:#6b7280">${state.noticesPanelOpen ? '▲' : '▼'}</span>
      </div>
      ${state.noticesPanelOpen ? `
      <div style="margin-top:10px">
        ${state.notices.length ? state.notices.map(n => `<p style="font-size:.9rem;color:#374151;margin-bottom:6px;border-bottom:1px solid #f3f4f6;padding-bottom:6px">${esc(n.message)}</p>`).join('') : '<p style="font-size:.85rem;color:#6b7280;margin-bottom:10px">No active notices.</p>'}
        <div style="margin-top:12px;border-top:1px solid #f3f4f6;padding-top:12px">
          <div class="card-title" style="color:#374151;font-size:.875rem;margin-bottom:6px">💬 Send suggestion to developers</div>
          <p style="font-size:.8rem;color:#b45309;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:8px 10px;margin-bottom:8px">⚠️ Do <strong>NOT</strong> submit any patient, location, or staff-identifiable work information here. Your suggestion will be sent to an NHS.net email address — please treat it accordingly. If you would like a reply, you are welcome to include your email address.</p>
          <textarea id="feedback-text" class="textarea" placeholder="Type your suggestion or feedback…" style="margin-bottom:8px;min-height:70px"></textarea>
          <div id="feedback-alerts"></div>
          <button class="btn btn-outline btn-sm" onclick="submitFeedback()">Send</button>
        </div>
      </div>` : ''}
    </div>`;

  // User messages section
  const unread = state.userMessages.filter(m => !m.read);
  const messagesHtml = unread.length ? `
    <div class="card" style="margin-top:12px;border-left:4px solid #10b981">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="card-title" style="color:#10b981">📬 Messages (${unread.length})</div>
        <button class="btn btn-outline btn-sm" onclick="markAllMessagesRead()">Mark all read</button>
      </div>
      ${unread.map(m => `
      <div style="font-size:.9rem;color:#374151;margin-bottom:8px;border-bottom:1px solid #f3f4f6;padding-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <span>${esc(m.message)}</span>
        <button class="btn btn-outline btn-sm" style="flex-shrink:0" onclick="markMessageRead(${m.id})">✓</button>
      </div>`).join('')}
    </div>` : '';

  return `
  <div class="view">
    <div class="view-header">
      <h1>👋 Tasker</h1>
      <a href="/guide" style="font-size:.8rem;color:#1a56db;font-weight:600;text-decoration:none;white-space:nowrap">📖 Guide</a>
    </div>
    ${midnightWarn ? '<div class="midnight-warn">⚠️ Approaching midnight — your session will end at midnight. Complete any active task.</div>' : ''}
    <div id="home-alerts"></div>
    ${noticesPanelHtml}
    ${messagesHtml}
    ${t ? `
    <div class="card" style="border: 2px solid #f59e0b;margin-top:12px">
      <div class="card-title">⏸️ Task In Progress</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? 'My Group' : 'Personal'}</span>
        ${t.category ? `<span style="font-size:.9rem;color:#374151;font-weight:600">${esc(t.category)}</span>` : ''}
        ${t.subcategory ? `<span style="font-size:.9rem;color:#6b7280">› ${esc(t.subcategory)}</span>` : ''}
      </div>
      <p style="font-size:.85rem;color:#6b7280;margin-bottom:4px">Started: ${formatTimeShort(t.start_time)}</p>
      ${t.interruptions?.length ? `<p style="font-size:.85rem;color:#d97706;margin-bottom:4px">⚠️ ${t.interruptions.length} interruption(s) recorded</p>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" style="flex:1" onclick="renderTaskActive()">▶ Resume</button>
        <button class="btn btn-secondary" style="flex:1" onclick="discardActiveTask()">✕ Abandon</button>
      </div>
    </div>` : `
    <button class="btn btn-primary btn-full" style="font-size:1.1rem;padding:18px;margin-top:12px" onclick="renderTaskStart()">
      ▶ Log Task
    </button>`}
    ${statsHTML}
    <div class="card" style="margin-top:16px">
      <div class="card-title">📋 Pending Tasks</div>
      <p style="font-size:.85rem;color:#6b7280;margin-bottom:8px">How many tasks do you have currently?</p>
      ${state.pendingTaskLog ? `<p style="font-size:.85rem;color:#6b7280;margin-bottom:8px">Last logged: <strong>${state.pendingTaskLog.count}</strong> (${formatDateShort(state.pendingTaskLog.logged_at)} ${formatTimeShort(state.pendingTaskLog.logged_at)})</p>` : ''}
      ${state.recentHandledCount !== null ? `<p style="font-size:.85rem;color:#6b7280;margin-bottom:8px">Tasks handled (last 7 days): <strong>${state.recentHandledCount}</strong></p>` : ''}
      <div style="display:flex;gap:8px;align-items:center">
        <input id="pending-count-input" class="input" type="number" min="0" max="9999" placeholder="Enter count…" style="flex:1">
        <button class="btn btn-primary" onclick="doLogPendingCount()">Log</button>
      </div>
      <div id="pending-count-alerts" style="margin-top:8px"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-sm ${state.pendingGraphDays === 7 ? 'btn-primary' : 'btn-secondary'}" onclick="togglePendingGraph(7)">📈 7 days</button>
        <button class="btn btn-sm ${state.pendingGraphDays === 30 ? 'btn-primary' : 'btn-secondary'}" onclick="togglePendingGraph(30)">📈 30 days</button>
      </div>
      ${state.pendingGraphDays ? `<div class="chart-container" style="height:180px;margin-top:12px"><canvas id="chart-pending"></canvas></div>` : ''}
    </div>
  ${renderFooter()}
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
  await loadNoticesAndMessages();
  if (state.activeTask) {
    await checkInactivityInterruption();
    updateLastActive();
    startActivityTracking();
  } else {
    stopActivityTracking();
  }
  if (state.currentView === 'home') {
    app().innerHTML = renderHomeHTML();
    if (state.pendingGraphDays) await renderPendingChart(state.pendingGraphDays);
  }
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

async function markMessageRead(msgId) {
  try {
    await api('POST', `/api/messages/${msgId}/read`, {});
    state.userMessages = state.userMessages.map(m => m.id === msgId ? { ...m, read: 1 } : m);
    app().innerHTML = renderHomeHTML();
    if (state.pendingGraphDays) await renderPendingChart(state.pendingGraphDays);
  } catch(e) {}
}

async function markAllMessagesRead() {
  try {
    await api('POST', '/api/messages/read-all', {});
    state.userMessages = state.userMessages.map(m => ({ ...m, read: 1 }));
    app().innerHTML = renderHomeHTML();
    if (state.pendingGraphDays) await renderPendingChart(state.pendingGraphDays);
  } catch(e) {}
}

// ── Notices panel helpers ─────────────────────────────────────────────────────

function getSeenNoticeIds() {
  try { return JSON.parse(localStorage.getItem('tasker_seen_notices') || '[]'); } catch { return []; }
}

function countUnreadNotices() {
  const seen = getSeenNoticeIds();
  return state.notices.filter(n => !seen.includes(n.id)).length;
}

function markNoticesRead() {
  const seen = getSeenNoticeIds();
  for (const n of state.notices) {
    if (!seen.includes(n.id)) seen.push(n.id);
  }
  localStorage.setItem('tasker_seen_notices', JSON.stringify(seen));
}

async function toggleNoticesPanel() {
  state.noticesPanelOpen = !state.noticesPanelOpen;
  if (state.noticesPanelOpen) markNoticesRead();
  app().innerHTML = renderHomeHTML();
  if (state.pendingGraphDays) await renderPendingChart(state.pendingGraphDays);
}

async function submitFeedback() {
  const msg = document.getElementById('feedback-text')?.value.trim();
  if (!msg) { showAlert('Please enter a message.', 'error', 'feedback-alerts'); return; }
  try {
    await api('POST', '/api/auth/feedback', { message: msg });
    showAlert('Feedback sent — thank you!', 'success', 'feedback-alerts');
    const ta = document.getElementById('feedback-text');
    if (ta) ta.value = '';
  } catch(e) { showAlert(e.message, 'error', 'feedback-alerts'); }
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
    if (state.pendingGraphDays) await renderPendingChart(state.pendingGraphDays);
  } catch(e) { showAlert(e.message, 'error', 'pending-count-alerts'); }
}

async function togglePendingGraph(days) {
  if (state.pendingGraphDays === days) {
    state.pendingGraphDays = null;
    if (state.charts['chart-pending']) { state.charts['chart-pending'].destroy(); delete state.charts['chart-pending']; }
    app().innerHTML = renderHomeHTML();
    return;
  }
  state.pendingGraphDays = days;
  app().innerHTML = renderHomeHTML();
  await renderPendingChart(days);
}

async function renderPendingChart(days) {
  try {
    const res = await fetch(`/api/tasks/pending-count/history?days=${days}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const logs = await res.json();
    if (!logs.length) return;
    const labels = logs.map(l => `${formatDateShort(l.logged_at)} ${formatTimeShort(l.logged_at)}`);
    const counts = logs.map(l => l.count);
    renderChart('chart-pending', 'line', labels, [{
      label: 'Pending tasks',
      data: counts,
      borderColor: '#1a56db',
      backgroundColor: 'rgba(26,86,219,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 3,
    }], {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { ticks: { maxRotation: 45 } } },
    });
  } catch(e) {}
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function renderSettings() {
  stopTimer(); clearCharts(); state.currentView = 'settings';
  pushHistory('settings');
  const showInvite = state.registrationConfig?.userInvite !== 'disabled';
  const groupName = state.user?.userGroupName;
  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <h1>⚙️ Settings</h1>
    </div>
    <div id="settings-alerts"></div>
    <div class="card">
      <p style="font-size:.9rem;color:#555;margin-bottom:14px">Logged in as: <strong>${esc(state.user?.username)}</strong></p>
      <div class="divider"></div>
      <div style="margin-bottom:14px">
        <p style="font-size:.85rem;color:#374151;margin-bottom:6px">👥 My User Group: <strong>${groupName ? esc(groupName) : 'Not set'}</strong></p>
        <button class="btn btn-outline btn-full" style="margin-bottom:6px" onclick="setGroupFromSettings()">${groupName ? '🔄 Change Group' : '👥 Select Group'}</button>
        ${groupName ? `<button class="btn btn-outline btn-full" onclick="openMyOptionsModal()">⚙️ Customise My Options</button>` : ''}
      </div>
      <div class="divider"></div>
      <button class="btn btn-outline btn-full" style="margin-bottom:10px" onclick="renderChangePassword()">🔑 Change Password</button>
      ${showInvite ? `<button class="btn btn-outline btn-full" style="margin-bottom:10px" id="invite-btn" onclick="doInviteUser()">👤 Invite a User</button>` : ''}
      <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="window.location.href='/policy'">📄 Data &amp; Use Policy</button>
      <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="window.location.href='/help'">❓ Help &amp; User Guide</button>
      <button class="btn btn-danger btn-full" style="margin-bottom:10px" onclick="doLogout()">🚪 Log Out</button>
      <div class="divider"></div>
      <button class="btn btn-danger btn-full" onclick="renderDeleteAccount()">🗑️ Delete My Account</button>
    </div>
  ${renderFooter()}
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
    ${buildQuickPickRow('category', 'ts-cat', state.commonFields.category, 2)}
    ${buildDropdownGroup('subcategory','Task Type', state.dropdowns.subcategory, 'ts-sub')}
    ${buildQuickPickRow('subcategory', 'ts-sub', state.commonFields.subcategory, 2)}
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
  return buildComboBox(field, label, options, containerId, true, null);
}

function buildQuickPickRow(field, containerId, values, cols) {
  if (!values || values.length === 0) return '';
  const colClass = cols === 3 ? ' quick-pick-grid--3col' : '';
  const max = cols === 3 ? 6 : 4;
  const items = values.slice(0, max).map(v =>
    `<button type="button" class="quick-pick-btn" data-container="${safeId(containerId)}" data-field="${safeId(field)}" data-value="${esc(v)}" onclick="handleQuickPick(this)">${esc(v)}</button>`
  ).join('');
  return `<div class="quick-pick-grid${colClass}">${items}</div>`;
}

function handleQuickPick(el) {
  selectComboOpt(el.dataset.container, el.dataset.field, el.dataset.value);
}

function buildRunningOutcomeGroup(options, current) {
  const sid = 'tr-outcome';
  const displayValue = current || '';
  const picks = (state.commonFields.outcome || []).slice(0, 6);
  const picksHtml = picks.length ? `
  <div id="tr-outcome-picks" class="quick-pick-grid quick-pick-grid--3col" style="margin-bottom:8px">
    ${picks.map(v => `<button type="button" class="quick-pick-btn${displayValue === v ? ' qp-selected' : ''}" data-value="${esc(v)}" onclick="handleRunningOutcomePick(this)">${esc(v)}</button>`).join('')}
  </div>` : '';
  return `
  <div class="form-group" style="margin-top:4px">
    <label>Task Outcome</label>
    ${picksHtml}
    <div class="combo-wrap" id="${sid}">
      <button type="button" id="${sid}-btn"
              class="combo-btn${displayValue ? '' : ' placeholder'}"
              onclick="openCombo('${sid}','outcome',false)"
              aria-haspopup="listbox" aria-expanded="false">
        ${displayValue ? esc(displayValue) : '— Select Outcome —'}
      </button>
      <div class="combo-panel" id="${sid}-panel" role="listbox">
        <input class="combo-search" id="${sid}-search" type="text" autocomplete="off"
               placeholder="Search…"
               oninput="filterCombo('${sid}','outcome',false)"
               onkeydown="comboKeydown(event,'${sid}','outcome',false)">
        <div class="combo-opts" id="${sid}-opts"></div>
      </div>
      <input type="hidden" id="${sid}-sel" value="${esc(displayValue)}">
    </div>
  </div>`;
}

function handleRunningOutcomePick(el) {
  selectRunningOutcome(el.dataset.value);
}

function selectRunningOutcome(value) {
  const hidden = document.getElementById('tr-outcome-sel');
  const btn = document.getElementById('tr-outcome-btn');
  if (hidden) hidden.value = value;
  if (btn) { btn.textContent = value; btn.classList.remove('placeholder'); }
  document.querySelectorAll('#tr-outcome-picks .quick-pick-btn').forEach(el => {
    el.classList.toggle('qp-selected', el.dataset.value === value);
  });
  closeCombo('tr-outcome');
}

function onDropdownChange(containerId, field) {
  // kept for backwards-compat — combobox now calls selectComboOpt directly
  const sel = document.getElementById(`${containerId}-sel`);
  if (sel) state.taskForm[field] = sel.value || null;
}

async function submitNewOption(containerId, field) {
  const input = document.getElementById(`${containerId}-new-input`);
  const val = (input?.value || '').trim();
  if (!val) return;
  try {
    const d = await api('POST', '/api/dropdowns/propose', { field_name: field, value: val });
    if (!d) return;
    // Update hidden input and combobox button
    const hidden = document.getElementById(`${containerId}-sel`);
    const btn    = document.getElementById(`${containerId}-btn`);
    if (hidden) hidden.value = val;
    if (btn) { btn.textContent = val + ' (pending)'; btn.classList.remove('placeholder'); }
    state.taskForm[field] = val;
    if (input) input.value = '';
    const newDiv = document.getElementById(`${containerId}-new`);
    if (newDiv) newDiv.style.display = 'none';
    const alertContainer = document.getElementById('ts-alerts') ? 'ts-alerts' : 'te-alerts';
    showAlert('Option submitted for review.', 'success', alertContainer);
  } catch(e) {
    const alertContainer = document.getElementById('ts-alerts') ? 'ts-alerts' : 'te-alerts';
    showAlert(e.message, 'error', alertContainer);
  }
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
    <div style="text-align:center;font-size:.85rem;color:#6b7280;margin-bottom:16px">
      Started: ${formatTimeShort(t.start_time)} 
      ${t.interruptions?.length ? ` · ${t.interruptions.length} interruption(s)` : ''}
    </div>
    ${buildRunningOutcomeGroup(state.dropdowns.outcome, t.outcome || null)}
    <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="showInterruptModal()">⏸️ Interrupted</button>
    <button class="btn btn-primary btn-full" style="margin-bottom:10px" onclick="renderTaskEnd()">⏹️ End Task</button>
    <button class="btn btn-danger btn-full" onclick="cancelActiveTask()">✕ Cancel Task</button>
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

async function cancelActiveTask() {
  if (!confirm('Cancel this task? It will be discarded and all data deleted.')) return;
  try {
    await api('PATCH', `/api/tasks/${state.activeTask.id}`, { status: 'discarded' });
    state.activeTask = null;
    stopActivityTracking();
    renderHome();
  } catch(e) { alert(e.message); }
}

// ── TASK END ─────────────────────────────────────────────────────────────────
function renderTaskEnd() {
  stopTimer();
  const t = state.activeTask;
  if (!t) { renderHome(); return; }
  t.end_time = new Date().toISOString();
  // Carry over any outcome selected on the Task Running page
  const runningOutcome = document.getElementById('tr-outcome-sel')?.value;
  if (runningOutcome) t.outcome = runningOutcome;
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
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid #e5e7eb;margin-bottom:12px">
        <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? '🏥 My Group' : '👤 Personal'}</span>
      </div>
      ${buildReviewDropdown('category', 'Task From', state.dropdowns.category, t.category)}
      ${buildReviewDropdown('subcategory', 'Task Type', state.dropdowns.subcategory, t.subcategory)}` : `
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

  const currentFlagIds = t.flag_ids || [];
  const flagsHtml = state.flagOptions.length ? `
      <div class="form-group">
        <details ${currentFlagIds.length ? 'open' : ''}>
          <summary style="font-weight:600;color:#374151;cursor:pointer;user-select:none">Task Flags <span style="font-size:.8rem;color:#6b7280;font-weight:400">(optional — select any that apply)</span></summary>
          <div id="te-flags" style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
            ${state.flagOptions.map(f => `
            <label style="display:flex;align-items:center;gap:8px;font-size:.9rem;cursor:pointer">
              <input type="checkbox" class="flag-check" data-id="${f.id}" ${currentFlagIds.includes(f.id) ? 'checked' : ''}
                     style="width:16px;height:16px;accent-color:#1a56db">
              ${esc(f.value)}
            </label>`).join('')}
          </div>
          <div id="te-flag-new" style="margin-top:8px;display:flex;gap:6px">
            <input id="te-flag-new-input" class="input" type="text" placeholder="Suggest a new flag…" style="flex:1">
            <button class="btn btn-outline btn-sm" onclick="suggestNewFlag()">Send</button>
          </div>
        </details>
      </div>` : '';

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
      ${flagsHtml}
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
  return buildComboBox(field, label, options, `te-${field}`, false, current || null);
}

function buildReviewOutcomeGroup(options, current) {
  const displayValue = current || '';
  return `
  <div class="form-group" id="te-out-group">
    <label>Outcome</label>
    <div class="combo-wrap" id="te-outcome">
      <button type="button" id="te-outcome-btn"
              class="combo-btn${displayValue ? '' : ' placeholder'}"
              onclick="openCombo('te-outcome','outcome',true)"
              aria-haspopup="listbox" aria-expanded="false">
        ${displayValue ? esc(displayValue) : '— Select Outcome —'}
      </button>
      <div class="combo-panel" id="te-outcome-panel" role="listbox">
        <input class="combo-search" id="te-outcome-search" type="text" autocomplete="off"
               placeholder="Search…"
               oninput="filterCombo('te-outcome','outcome',true)"
               onkeydown="comboKeydown(event,'te-outcome','outcome',true)">
        <div class="combo-opts" id="te-outcome-opts"></div>
      </div>
      <input type="hidden" id="te-outcome-sel" value="${esc(displayValue)}">
    </div>
    <div id="te-outcome-new" style="display:none" class="add-new-row">
      <input id="te-outcome-new-input" class="input" type="text" placeholder="Type new outcome…">
      <button class="btn btn-outline btn-sm" onclick="submitNewOutcomeEnd()">Add</button>
    </div>
  </div>`;
}

async function suggestNewFlag() {
  const input = document.getElementById('te-flag-new-input');
  const val = (input?.value || '').trim();
  if (!val) return;
  try {
    const d = await api('POST', '/api/flags/propose', { value: val });
    if (!d) return;
    if (input) input.value = '';
    showAlert(d.message || 'Suggestion sent.', 'success', 'te-alerts');
  } catch(e) { showAlert(e.message, 'error', 'te-alerts'); }
}


async function submitNewOutcomeEnd() {
  const input = document.getElementById('te-outcome-new-input');
  const val = (input?.value || '').trim();
  if (!val) return;
  try {
    await api('POST', '/api/dropdowns/propose', { field_name: 'outcome', value: val });
    const hidden = document.getElementById('te-outcome-sel');
    const btn    = document.getElementById('te-outcome-btn');
    if (hidden) hidden.value = val;
    if (btn) { btn.textContent = val + ' (pending)'; btn.classList.remove('placeholder'); }
    if (input) input.value = '';
    document.getElementById('te-outcome-new').style.display = 'none';
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
  const outcome = document.getElementById('te-outcome-sel')?.value || null;
  if (!outcome) { showAlert('Please select an Outcome.', 'error', 'te-alerts'); return; }
  const dutyEl = document.getElementById('te-duty');
  const categoryVal = document.getElementById('te-category-sel')?.value || t.category || null;
  const subcategoryVal = document.getElementById('te-subcategory-sel')?.value || t.subcategory || null;
  if (isEdit && !categoryVal) { showAlert('Please select a Task From.', 'error', 'te-alerts'); return; }
  if (isEdit && !subcategoryVal) { showAlert('Please select a Task Type.', 'error', 'te-alerts'); return; }
  if (!isEdit && !categoryVal) { showAlert('Please select a Task From.', 'error', 'te-alerts'); return; }
  if (!isEdit && !subcategoryVal) { showAlert('Please select a Task Type.', 'error', 'te-alerts'); return; }
  // Collect selected flag IDs
  const flagChecks = document.querySelectorAll('#te-flags .flag-check:checked');
  const flag_ids = Array.from(flagChecks).map(el => Number(el.dataset.id));
  const body = {
    status: 'completed',
    is_duty: dutyEl ? (dutyEl.classList.contains('active') ? 1 : 0) : (t.is_duty ? 1 : 0),
    category: categoryVal,
    subcategory: subcategoryVal,
    outcome,
    flag_ids,
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
      state.lastUsedCombos = { category: categoryVal, subcategory: subcategoryVal };
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
  state.analyticsQuickPeriod = 'today';
  state.analyticsFiltersExpanded = false;
  state.analyticsFilterFrom = '';
  state.analyticsFilterTo = '';
  state.analyticsFilterDuty = '';
  state.analyticsFilterCategory = '';
  state.analyticsFilterSubcategory = '';
  state.analyticsFilterOutcome = '';
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
  const params = buildHistoryParams();
  app().innerHTML = `<div class="view"><p class="loading">Loading history…</p></div>`;
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
  // Snapshot current DOM filter values into state while the filter panel is still rendered
  const fromEl = document.getElementById('h-from');
  const toEl = document.getElementById('h-to');
  const dutyEl = document.getElementById('h-duty');
  const catEl = document.getElementById('h-cat');
  const subEl = document.getElementById('h-sub');
  const outEl = document.getElementById('h-out');
  if (fromEl !== null) state.analyticsFilterFrom = fromEl.value;
  if (toEl !== null) state.analyticsFilterTo = toEl.value;
  if (dutyEl !== null) state.analyticsFilterDuty = dutyEl.value;
  if (catEl !== null) state.analyticsFilterCategory = catEl.value;
  if (subEl !== null) state.analyticsFilterSubcategory = subEl.value;
  if (outEl !== null) state.analyticsFilterOutcome = outEl.value;

  // Build params from persisted state (date inputs override quick-filter dates)
  const from = state.analyticsFilterFrom || state.analyticsQuickFrom || '';
  const to = state.analyticsFilterTo || state.analyticsQuickTo || '';
  const isDuty = state.analyticsFilterDuty;
  const cat = state.analyticsFilterCategory;
  const sub = state.analyticsFilterSubcategory;
  const out = state.analyticsFilterOutcome;
  const parts = [];
  if (from) parts.push('from=' + encodeURIComponent(from));
  if (to) parts.push('to=' + encodeURIComponent(to));
  if (isDuty) parts.push('is_duty=' + (isDuty === 'duty' ? 'true' : 'false'));
  if (cat) parts.push('category=' + encodeURIComponent(cat));
  if (sub) parts.push('subcategory=' + encodeURIComponent(sub));
  if (out) parts.push('outcome=' + encodeURIComponent(out));
  return parts.length ? '?' + parts.join('&') : '';
}

function setDatePreset(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days + 1);
  const fmt = d => d.toISOString().split('T')[0];
  state.analyticsQuickPeriod = null;
  state.analyticsQuickFrom = '';
  state.analyticsQuickTo = '';
  state.analyticsFilterFrom = fmt(from);
  state.analyticsFilterTo = fmt(to);
  renderAnalyticsHistory();
}

function applyHistoryFilters() {
  state.analyticsQuickPeriod = null;
  renderAnalyticsHistory();
}

function setAnalyticsQuickFilter(period) {
  state.analyticsFiltersExpanded = false;
  state.analyticsQuickPeriod = period;
  state.analyticsFilterFrom = '';
  state.analyticsFilterTo = '';
  if (period === 'today') {
    const today = new Date().toISOString().split('T')[0];
    state.analyticsQuickFrom = today;
    state.analyticsQuickTo = today;
    renderAnalyticsHistory();
  } else {
    const days = period === '30d' ? 30 : 7;
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days + 1);
    const fmt = d => d.toISOString().split('T')[0];
    state.analyticsQuickFrom = fmt(from);
    state.analyticsQuickTo = fmt(to);
    renderAnalyticsHistory();
  }
}

function renderAnalyticsContent(data, mode, pendingLog) {
  state.analyticsData = { data, mode, pendingLog };
  const { tasks, summary: s } = data;
  const isHistory = mode === 'history';
  const pendingLabel = pendingLog
    ? `${pendingLog.count} <span style="font-size:.65rem;display:block;color:#6b7280;margin-top:2px">(${formatDateShort(pendingLog.logged_at)})</span>`
    : '—';

  const qp = state.analyticsQuickPeriod;
  const timingBar = `
  <div class="date-preset-group" style="margin-bottom:14px">
    <button class="btn btn-sm ${qp === 'today' ? 'btn-primary' : 'btn-secondary'}" onclick="setAnalyticsQuickFilter('today')">Today</button>
    <button class="btn btn-sm ${qp === '7d' ? 'btn-primary' : 'btn-secondary'}" onclick="setAnalyticsQuickFilter('7d')">Last 7 days</button>
    <button class="btn btn-sm ${qp === '30d' ? 'btn-primary' : 'btn-secondary'}" onclick="setAnalyticsQuickFilter('30d')">Last 30 days</button>
  </div>`;

  const filtersExpanded = state.analyticsFiltersExpanded;
  const filterBar = `
  <div class="card filter-card" style="margin-bottom:14px">
    <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin-bottom:0" onclick="toggleAnalyticsFilters()">
      <span>🔍 Advanced Filters</span>
      <button type="button" class="btn btn-outline btn-sm" style="pointer-events:none">${filtersExpanded ? '▲ Collapse' : '▼ Expand'}</button>
    </div>
    ${filtersExpanded ? `
    <div style="margin-top:12px">
    <div class="date-preset-group">
      <button class="btn btn-sm btn-secondary" onclick="setDatePreset(7)">7 days</button>
      <button class="btn btn-sm btn-secondary" onclick="setDatePreset(14)">14 days</button>
      <button class="btn btn-sm btn-secondary" onclick="setDatePreset(30)">30 days</button>
    </div>
    <div class="filter-bar" style="margin-bottom:0">
      <div class="form-group" style="margin-bottom:0">
        <label>From date</label>
        <input id="h-from" class="input" type="date" value="${state.analyticsFilterFrom}">
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label>To date</label>
        <input id="h-to" class="input" type="date" value="${state.analyticsFilterTo}">
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label>Type</label>
        <select id="h-duty" class="select">
          <option value="" ${!state.analyticsFilterDuty ? 'selected' : ''}>All</option>
          <option value="duty" ${state.analyticsFilterDuty === 'duty' ? 'selected' : ''}>My Group only</option>
          <option value="personal" ${state.analyticsFilterDuty === 'personal' ? 'selected' : ''}>Personal only</option>
        </select>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label>Category</label>
        <select id="h-cat" class="select">
          <option value="" ${!state.analyticsFilterCategory ? 'selected' : ''}>All</option>
          ${state.dropdowns.category.map(c => `<option value="${esc(c)}" ${state.analyticsFilterCategory === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label>Task type</label>
        <select id="h-sub" class="select">
          <option value="" ${!state.analyticsFilterSubcategory ? 'selected' : ''}>All</option>
          ${state.dropdowns.subcategory.map(o => `<option value="${esc(o)}" ${state.analyticsFilterSubcategory === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label>Outcome</label>
        <select id="h-out" class="select">
          <option value="" ${!state.analyticsFilterOutcome ? 'selected' : ''}>All</option>
          ${state.dropdowns.outcome.map(o => `<option value="${esc(o)}" ${state.analyticsFilterOutcome === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-primary btn-full" onclick="applyHistoryFilters()">Apply Filters</button>
    </div>
    </div>` : ''}
  </div>`;

  // Build task cards grouped by Task From (category)
  const groupedTaskCards = (() => {
    if (!tasks.length) return '<p style="color:#6b7280;font-size:.9rem">No tasks found.</p>';
    const groups = {};
    tasks.forEach(t => {
      const cat = t.category || 'Uncategorised';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(t);
    });
    return Object.entries(groups).map(([cat, catTasks]) => `
      <div class="section-heading" style="margin-top:8px;margin-bottom:6px">${esc(cat)}</div>
      ${catTasks.map(t => {
        const dur = calcDurMins(t);
        return `<div class="card task-card">
          <div class="task-card-row">
            <span class="badge ${t.is_duty ? 'badge-duty' : 'badge-personal'}">${t.is_duty ? 'My Group' : 'Personal'}</span>
            <span class="task-card-meta">${formatTimeShort(t.start_time)} — ${formatTimeShort(t.end_time) || '?'} (${dur}m)</span>
          </div>
          <div class="task-card-title">${esc(t.category || 'Uncategorised')}${t.subcategory ? ' › ' + esc(t.subcategory) : ''}</div>
          ${t.outcome ? `<div class="task-card-meta">Outcome: ${esc(t.outcome)}</div>` : ''}
          ${t.interruptions?.length ? `<div class="task-card-meta">⚠️ ${t.interruptions.length} interruption(s)</div>` : ''}
          ${t.flag_labels?.length ? `<div class="task-card-meta" style="color:#dc2626">🚩 ${t.flag_labels.map(f => esc(f)).join(', ')}</div>` : ''}
          <div class="task-card-actions">
            <button class="btn btn-outline btn-sm" onclick="loadAndEditTask(${t.id})">✏️ Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteTask(${t.id})">🗑️ Delete</button>
          </div>
        </div>`;
      }).join('')}
    `).join('');
  })();

  const regressionNote = s.regression ? `
  <div class="alert alert-info" style="font-size:.85rem">
    📈 Trend: ${s.regression.slope > 0 ? '+' : ''}${s.regression.slope} tasks/day &nbsp;·&nbsp; R²=${s.regression.r2}${Math.abs(s.regression.slope) < 0.1 ? ' (stable)' : s.regression.slope > 0 ? ' (increasing)' : ' (decreasing)'}
  </div>` : '';

  // Build insight cards
  const insightItems = buildInsights(s);
  const insightSection = insightItems.length > 0 ? `
  <div class="card">
    <div class="card-title">💡 Insights</div>
    <div class="insights-grid">${insightItems.map(i => `<div class="insight-item">${i}</div>`).join('')}</div>
  </div>` : '';

  // Determine which charts to show
  const hasMultiDates = isHistory && s.dates?.length > 1;
  const subLabels = Object.keys(s.bySubcategory || {}).filter(k => k !== 'Unspecified' || Object.keys(s.bySubcategory).length === 1);
  const hasSubcategory = subLabels.length > 0;
  const hasHour = Object.keys(s.byHour || {}).length > 0;
  const hasDow = Object.keys(s.byDayOfWeek || {}).length > 0;
  const hasOutcome = Object.keys(s.byOutcome || {}).length > 0;
  const hasFlags = Object.keys(s.byFlag || {}).length > 0;
  const byCatSubCats = Object.keys(s.byCategoryBySubcategory || {});
  const hasCatSub = hasSubcategory && (
    byCatSubCats.length > 1 ||
    byCatSubCats.some(c => Object.keys(s.byCategoryBySubcategory[c] || {}).length > 1)
  );
  const dowSubTypes = new Set(Object.values(s.byDowBySubcategory || {}).flatMap(v => Object.keys(v)));
  const hasDowSub = hasDow && dowSubTypes.size > 1;
  const hasFlagCat = hasFlags && Object.keys(s.byFlagByCategory || {}).length > 0;
  const hasOutcomeCat = hasOutcome && Object.keys(s.byCategory || {}).length > 1;
  const hasLag = !!(s.lagStats && s.lagStats.count > 0);
  const personalDowCatTypes = new Set(Object.values(s.byDowPersonalByCategory || {}).flatMap(v => Object.keys(v)));
  const hasPersonalDowCat = personalDowCatTypes.size > 0;
  const personalDowSubTypes = new Set(Object.values(s.byDowPersonalBySubcategory || {}).flatMap(v => Object.keys(v)));
  const hasPersonalDowSub = personalDowSubTypes.size > 0;

  app().innerHTML = `
  <div class="view">
    <div class="view-header">
      <h1>📊 Analytics</h1>
    </div>
    <div class="retention-notice">⏳ Your data is automatically deleted after 30 days.</div>
    ${timingBar}
    ${filterBar}
    <div class="stat-grid stat-grid-3">
      <div class="stat-card"><div class="stat-number">${s.total}</div><div class="stat-label">Total tasks</div></div>
      <div class="stat-card"><div class="stat-number">${s.totalMins}</div><div class="stat-label">Total mins</div></div>
      <div class="stat-card"><div class="stat-number">${s.avgDurMins ?? 0}</div><div class="stat-label">Avg mins/task</div></div>
      <div class="stat-card"><div class="stat-number">${s.dutyCount}</div><div class="stat-label">My Group tasks</div></div>
      <div class="stat-card"><div class="stat-number">${s.personalCount}</div><div class="stat-label">Personal</div></div>
      <div class="stat-card"><div class="stat-number">${s.totalInterruptions || 0}</div><div class="stat-label">Interruptions</div></div>
      <div class="stat-card"><div class="stat-number">${s.avgInterruptionsPerTask ?? 0}</div><div class="stat-label">Avg intr/task</div></div>
      <div class="stat-card"><div class="stat-number">${s.tasksWithFlags ?? 0}</div><div class="stat-label">Flagged tasks</div></div>
      <div class="stat-card"><div class="stat-number">${pendingLabel}</div><div class="stat-label">Pending tasks</div></div>
    </div>
    ${regressionNote}
    ${insightSection}
    ${s.total > 0 ? `
    <div class="card">
      <div class="card-title">Time by Category (mins)</div>
      <div class="chart-container" style="height:240px"><canvas id="chart-cat"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">My Group vs Personal</div>
      <div class="chart-container" style="height:200px"><canvas id="chart-split"></canvas></div>
    </div>
    ${hasOutcome ? `
    <div class="card">
      <div class="card-title">Outcome Distribution</div>
      <div class="chart-container" style="height:220px"><canvas id="chart-outcome"></canvas></div>
    </div>` : ''}
    ${hasOutcomeCat ? `
    <div class="card">
      <div class="card-title">Outcome Breakdown by Category</div>
      <div class="chart-container" style="height:510px"><canvas id="chart-outcome-cat"></canvas></div>
    </div>` : ''}
    <div class="card">
      <div class="card-title">Avg Duration by Category (mins)</div>
      <div class="chart-container" style="height:${Math.max(180, Object.keys(s.byCategory).length * 44)}px"><canvas id="chart-cat-dur"></canvas></div>
    </div>
    ${hasSubcategory ? `
    <div class="card">
      <div class="card-title">Tasks by Type</div>
      <div class="chart-container" style="height:${Math.max(180, subLabels.length * 44)}px"><canvas id="chart-sub"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Avg Duration by Task Type (mins)</div>
      <div class="chart-container" style="height:${Math.max(180, subLabels.length * 44)}px"><canvas id="chart-sub-dur"></canvas></div>
    </div>` : ''}
    ${hasCatSub ? `
    <div class="card">
      <div class="card-title">Task Types by Source Group</div>
      <div class="chart-container" style="height:540px"><canvas id="chart-cat-sub"></canvas></div>
    </div>` : ''}
    ${hasFlags ? `
    <div class="card">
      <div class="card-title">Task Flag Distribution</div>
      <div class="chart-container" style="height:${Math.max(180, Object.keys(s.byFlag).length * 44)}px"><canvas id="chart-flags"></canvas></div>
    </div>` : ''}
    ${hasFlagCat ? `
    <div class="card">
      <div class="card-title">Flags by Source Group</div>
      <div class="chart-container" style="height:${Math.max(420, Object.keys(s.byFlagByCategory || {}).length * 44)}px"><canvas id="chart-flag-cat"></canvas></div>
    </div>` : ''}
    ${hasHour ? `
    <div class="card">
      <div class="card-title">Activity by Hour of Day</div>
      <div class="chart-container" style="height:200px"><canvas id="chart-hour"></canvas></div>
    </div>` : ''}
    ${hasDow ? `
    <div class="card">
      <div class="card-title">Activity by Day of Week</div>
      <div class="chart-container" style="height:200px"><canvas id="chart-dow"></canvas></div>
    </div>` : ''}
    ${hasDowSub ? `
    <div class="card">
      <div class="card-title">Task Type Patterns by Day Assigned</div>
      <div class="chart-container" style="height:540px"><canvas id="chart-dow-sub"></canvas></div>
    </div>` : ''}
    ${hasPersonalDowCat ? `
    <div class="card">
      <div class="card-title">Personal Tasks by Day Assigned — by Task Origin</div>
      <div class="chart-container" style="height:300px"><canvas id="chart-personal-dow-cat"></canvas></div>
    </div>` : ''}
    ${hasPersonalDowSub ? `
    <div class="card">
      <div class="card-title">Personal Tasks by Day Assigned — by Task Type</div>
      <div class="chart-container" style="height:300px"><canvas id="chart-personal-dow-sub"></canvas></div>
    </div>` : ''}
    ${hasMultiDates ? `
    <div class="card">
      <div class="card-title">Tasks &amp; Time Over Time</div>
      <div class="chart-container" style="height:220px"><canvas id="chart-trend"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Interruptions Over Time</div>
      <div class="chart-container" style="height:200px"><canvas id="chart-intr-trend"></canvas></div>
    </div>` : ''}
    ${hasLag ? `
    <div class="card">
      <div class="card-title">Days from Assignment to Action</div>
      ${s.lagStatsDuty && s.lagStatsDuty.count > 0 ? `<p style="font-size:.8rem;color:#6b7280;margin:0 0 4px">My Group — Avg: ${s.lagStatsDuty.avg}d &nbsp;·&nbsp; Median: ${s.lagStatsDuty.median}d &nbsp;·&nbsp; Range: ${s.lagStatsDuty.min}–${s.lagStatsDuty.max}d</p>` : ''}
      ${s.lagStatsPersonal && s.lagStatsPersonal.count > 0 ? `<p style="font-size:.8rem;color:#6b7280;margin:0 0 8px">Personal — Avg: ${s.lagStatsPersonal.avg}d &nbsp;·&nbsp; Median: ${s.lagStatsPersonal.median}d &nbsp;·&nbsp; Range: ${s.lagStatsPersonal.min}–${s.lagStatsPersonal.max}d</p>` : ''}
      <div class="chart-container" style="height:360px"><canvas id="chart-lag"></canvas></div>
    </div>` : ''}
    ` : '<div class="card"><p style="color:#6b7280;text-align:center;padding:20px">No completed tasks yet.</p></div>'}
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-secondary" style="flex:1" onclick="downloadExport()">⬇️ Download Log (.xlsx)</button>
      <button class="btn btn-secondary" style="flex:1" onclick="exportAnalyticsPdf()">📄 Print / Save as PDF</button>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin:20px 0 10px">
      <div class="section-heading" style="margin:0">Tasks</div>
      <button class="btn btn-outline btn-sm" onclick="toggleAnalyticsTasks()">${state.analyticsTasksExpanded ? '▲ Collapse' : '▼ Expand'}</button>
    </div>
    ${state.analyticsTasksExpanded ? `
      ${tasks.length > 0 ? `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn btn-danger btn-sm" onclick="clearAllTasks()">🗑️ Clear All</button></div>` : ''}
      ${groupedTaskCards}
    ` : ''}
  ${renderFooter()}
  </div>
  ${renderBottomNav('analytics')}`;

  // Render charts
  if (s.total > 0) {
    // Category time doughnut
    const catLabels = Object.keys(s.byCategory);
    const catMins = catLabels.map(k => s.byCategory[k].minutes);
    renderChart('chart-cat', 'doughnut', catLabels, [{ data: catMins, backgroundColor: COLORS }], { plugins: { legend: { position: 'bottom' } } });

    // Outcome distribution doughnut
    if (hasOutcome) {
      const outLabels = Object.keys(s.byOutcome);
      const outCounts = outLabels.map(k => s.byOutcome[k]);
      renderChart('chart-outcome', 'doughnut', outLabels, [{ data: outCounts, backgroundColor: COLORS }], { plugins: { legend: { position: 'bottom' } } });
    }

    // Avg duration by category horizontal bar
    const catAvgLabels = catLabels;
    const catAvgMins = catLabels.map(k => s.byCategory[k].count > 0 ? Math.round(s.byCategory[k].minutes / s.byCategory[k].count) : 0);
    renderChart('chart-cat-dur', 'bar', catAvgLabels, [{ label: 'Avg mins', data: catAvgMins, backgroundColor: COLORS }],
      { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } });

    // My Group vs personal bar
    renderChart('chart-split', 'bar', ['My Group', 'Personal'],
      [
        { label: 'Tasks', data: [s.dutyCount, s.personalCount], backgroundColor: ['#1a56db','#7c3aed'] },
        { label: 'Mins', data: [s.dutyMins || 0, s.personalMins || 0], backgroundColor: ['rgba(26,86,219,.4)','rgba(124,58,237,.4)'] },
      ],
      { plugins: { legend: { position: 'bottom' } } });

    // Subcategory horizontal bar
    if (hasSubcategory) {
      const subCounts = subLabels.map(k => s.bySubcategory[k].count);
      renderChart('chart-sub', 'bar', subLabels, [{ label: 'Tasks', data: subCounts, backgroundColor: COLORS }],
        { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } });
    }

    // Hour-of-day bar chart
    if (hasHour) {
      const hourKeys = Array.from({ length: 24 }, (_, i) => i);
      const hourLabels = hourKeys.map(h => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
      const hourCounts = hourKeys.map(h => (s.byHour[h] || { count: 0 }).count);
      renderChart('chart-hour', 'bar', hourLabels, [{ label: 'Tasks', data: hourCounts, backgroundColor: '#1a56db' }],
        { plugins: { legend: { display: false } }, scales: { x: { ticks: { maxRotation: 45 } }, y: { beginAtZero: true, ticks: { stepSize: 1 } } } });
    }

    // Day-of-week bar chart
    if (hasDow) {
      const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dowCounts = dowNames.map((_, i) => (s.byDayOfWeek[i] || { count: 0 }).count);
      renderChart('chart-dow', 'bar', dowNames, [{ label: 'Tasks', data: dowCounts, backgroundColor: COLORS }],
        { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } });
    }

    // Flag distribution bar chart
    if (hasFlags) {
      const flagLabels = Object.keys(s.byFlag);
      const flagCounts = flagLabels.map(k => s.byFlag[k]);
      renderChart('chart-flags', 'bar', flagLabels, [{ label: 'Count', data: flagCounts, backgroundColor: '#dc2626' }],
        { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } } });
    }

    // Trend + interruptions over time (history only)
    if (hasMultiDates) {
      const shortDates = s.dates.map(d => {
        const parts = d.split('-');
        return parts.length === 3 ? `${parseInt(parts[2])}/${parseInt(parts[1])}` : d;
      });
      const counts = s.dates.map(d => s.byDate[d].count);
      const mins_ = s.dates.map(d => s.byDate[d].minutes);
      const trendDatasets = [
        { label: 'Tasks', data: counts, borderColor: '#1a56db', backgroundColor: 'rgba(26,86,219,.1)', tension: 0.3, fill: true, yAxisID: 'y' },
        { label: 'Mins', data: mins_, borderColor: '#059669', backgroundColor: 'rgba(5,150,105,.08)', tension: 0.3, fill: false, yAxisID: 'y1' },
      ];
      if (s.regression) {
        const reg = s.dates.map((_, i) => Math.round((s.regression.slope * i + s.regression.intercept) * 10) / 10);
        trendDatasets.push({ label: 'Count trend', data: reg, borderColor: '#dc2626', borderDash: [5,5], pointRadius: 0, tension: 0, fill: false, yAxisID: 'y' });
      }
      renderChart('chart-trend', 'line', shortDates, trendDatasets, {
        plugins: { legend: { position: 'bottom' } },
        scales: {
          y:  { beginAtZero: true, position: 'left',  title: { display: true, text: 'Tasks' }, ticks: { stepSize: 1 } },
          y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Mins'  }, grid: { drawOnChartArea: false } },
        },
      });

      // Interruptions over time line
      const intrCounts = s.dates.map(d => {
        const dayTasks = tasks.filter(t => (t.start_time || '').startsWith(d));
        return dayTasks.reduce((n, t) => n + (t.interruptions?.length || 0), 0);
      });
      renderChart('chart-intr-trend', 'line', shortDates,
        [{ label: 'Interruptions', data: intrCounts, borderColor: '#d97706', backgroundColor: 'rgba(217,119,6,.1)', tension: 0.3, fill: true }],
        { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } });
    }

    // Avg duration by task type (subcategory) — horizontal bar
    if (hasSubcategory) {
      const subAvgDur = subLabels.map(k => s.bySubcategory[k] && s.bySubcategory[k].count > 0
        ? Math.round(s.bySubcategory[k].minutes / s.bySubcategory[k].count) : 0);
      renderChart('chart-sub-dur', 'bar', subLabels,
        [{ label: 'Avg mins', data: subAvgDur, backgroundColor: COLORS }],
        { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } });
    }

    // Task types by source group — stacked bar (category × subcategory)
    if (hasCatSub) {
      const csCategories = Object.keys(s.byCategoryBySubcategory);
      const allSubTypes = [...new Set(csCategories.flatMap(c => Object.keys(s.byCategoryBySubcategory[c])))];
      const csDatasets = allSubTypes.map((sub, i) => ({
        label: sub,
        data: csCategories.map(c => (s.byCategoryBySubcategory[c][sub] || 0)),
        backgroundColor: COLORS[i % COLORS.length],
      }));
      renderChart('chart-cat-sub', 'bar', csCategories, csDatasets,
        { plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } });
    }

    // Task type patterns by day of week — stacked bar
    if (hasDowSub) {
      const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const allDowSubs = [...new Set(Object.values(s.byDowBySubcategory).flatMap(v => Object.keys(v)))];
      const dowSubDatasets = allDowSubs.map((sub, i) => ({
        label: sub,
        data: dowNames.map((_, di) => ((s.byDowBySubcategory[di] || {})[sub] || 0)),
        backgroundColor: COLORS[i % COLORS.length],
      }));
      renderChart('chart-dow-sub', 'bar', dowNames, dowSubDatasets,
        { plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } } });
    }

    // Personal tasks by day assigned — by task origin (category) — stacked column
    if (hasPersonalDowCat) {
      const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const allPersonalCats = [...new Set(Object.values(s.byDowPersonalByCategory).flatMap(v => Object.keys(v)))];
      const personalDowCatDatasets = allPersonalCats.map((cat, i) => ({
        label: cat,
        data: dowNames.map((_, di) => ((s.byDowPersonalByCategory[di] || {})[cat] || 0)),
        backgroundColor: COLORS[i % COLORS.length],
      }));
      renderChart('chart-personal-dow-cat', 'bar', dowNames, personalDowCatDatasets,
        { plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } } });
    }

    // Personal tasks by day assigned — by task type (subcategory) — stacked column
    if (hasPersonalDowSub) {
      const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const allPersonalSubs = [...new Set(Object.values(s.byDowPersonalBySubcategory).flatMap(v => Object.keys(v)))];
      const personalDowSubDatasets = allPersonalSubs.map((sub, i) => ({
        label: sub,
        data: dowNames.map((_, di) => ((s.byDowPersonalBySubcategory[di] || {})[sub] || 0)),
        backgroundColor: COLORS[i % COLORS.length],
      }));
      renderChart('chart-personal-dow-sub', 'bar', dowNames, personalDowSubDatasets,
        { plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } } });
    }

    // Outcome breakdown by category — stacked bar
    if (hasOutcomeCat) {
      const allOutcomes = Object.keys(s.byOutcome);
      const ocDatasets = allOutcomes.map((out, i) => ({
        label: out,
        data: catLabels.map(c => ((s.byOutcomeByCategory[out] || {})[c] || 0)),
        backgroundColor: COLORS[i % COLORS.length],
      }));
      renderChart('chart-outcome-cat', 'bar', catLabels, ocDatasets,
        { plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } } });
    }

    // Flags by source group — horizontal stacked bar
    if (hasFlagCat) {
      const flagCatFlags = Object.keys(s.byFlagByCategory);
      const allFlagCats = [...new Set(flagCatFlags.flatMap(f => Object.keys(s.byFlagByCategory[f])))];
      const fcDatasets = allFlagCats.map((cat, i) => ({
        label: cat,
        data: flagCatFlags.map(f => ((s.byFlagByCategory[f] || {})[cat] || 0)),
        backgroundColor: COLORS[i % COLORS.length],
      }));
      renderChart('chart-flag-cat', 'bar', flagCatFlags, fcDatasets,
        { indexAxis: 'y', plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true, beginAtZero: true }, y: { stacked: true } } });
    }

    // Assignment-to-action lag distribution — stacked bar chart (My Group vs Personal)
    if (hasLag) {
      const lagBucketOrder = ['0','1','2','3','4','5','6','7','8–14','15–30','>30'];
      const lagLabels = lagBucketOrder.filter(k =>
        (s.lagStatsDuty   && s.lagStatsDuty.buckets[k]   !== undefined) ||
        (s.lagStatsPersonal && s.lagStatsPersonal.buckets[k] !== undefined)
      );
      const lagDatasets = [];
      if (s.lagStatsDuty && s.lagStatsDuty.count > 0) {
        lagDatasets.push({ label: 'My Group', data: lagLabels.map(k => s.lagStatsDuty.buckets[k] || 0), backgroundColor: '#1a56db' });
      }
      if (s.lagStatsPersonal && s.lagStatsPersonal.count > 0) {
        lagDatasets.push({ label: 'Personal', data: lagLabels.map(k => s.lagStatsPersonal.buckets[k] || 0), backgroundColor: '#7c3aed' });
      }
      if (lagDatasets.length === 0) {
        lagDatasets.push({ label: 'Tasks', data: lagLabels.map(k => s.lagStats.buckets[k] || 0), backgroundColor: '#0891b2' });
      }
      renderChart('chart-lag', 'bar', lagLabels, lagDatasets,
        { plugins: { legend: { position: 'bottom' } }, scales: {
          x: { stacked: true, title: { display: true, text: 'Days' } },
          y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } },
        } });
    }
  }
}

function buildInsights(s) {
  if (s.total === 0) return [];
  const items = [];

  // Busiest hour
  const hourEntries = Object.entries(s.byHour || {});
  if (hourEntries.length > 0) {
    const [h] = hourEntries.sort((a, b) => b[1].count - a[1].count)[0];
    const hour = parseInt(h);
    const label = hour === 0 ? '12am' : hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`;
    items.push(`🕐 <strong>Busiest hour:</strong> ${label}`);
  }

  // Busiest day of week
  const dowEntries = Object.entries(s.byDayOfWeek || {});
  if (dowEntries.length > 0) {
    const [d] = dowEntries.sort((a, b) => b[1].count - a[1].count)[0];
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    items.push(`📅 <strong>Busiest day:</strong> ${dayNames[parseInt(d)]}`);
  }

  // Most time-consuming category
  const catEntries = Object.entries(s.byCategory || {});
  if (catEntries.length > 0) {
    const [cat, cv] = catEntries.sort((a, b) => b[1].minutes - a[1].minutes)[0];
    items.push(`⏱️ <strong>Most time:</strong> ${esc(cat)} (${cv.minutes}m)`);
  }

  // Most interrupted category
  const intrCatEntries = Object.entries(s.interruptionsByCategory || {}).filter(([,v]) => v > 0);
  if (intrCatEntries.length > 0) {
    const [cat] = intrCatEntries.sort((a, b) => b[1] - a[1])[0];
    items.push(`⚠️ <strong>Most interrupted:</strong> ${esc(cat)}`);
  }

  // Efficiency: avg duration note
  if (s.avgDurMins > 0) {
    const note = s.avgDurMins < 10 ? 'short tasks' : s.avgDurMins < 30 ? 'moderate tasks' : 'longer tasks';
    items.push(`📊 <strong>Avg task:</strong> ${s.avgDurMins}m (${note})`);
  }

  // Interruption rate: percentage of tasks that had at least one interruption
  if (s.total > 0 && s.tasksWithInterruptions > 0) {
    const pct = Math.round((s.tasksWithInterruptions / s.total) * 100);
    items.push(`🔔 <strong>Interruption rate:</strong> ${pct}% of tasks`);
  }

  // Average assignment-to-action lag
  if (s.lagStats && s.lagStats.count > 0) {
    let lagNote;
    if (s.lagStats.avg === 0) { lagNote = 'same day'; }
    else if (s.lagStats.avg <= 1) { lagNote = 'next day'; }
    else { lagNote = `${s.lagStats.avg} days`; }
    items.push(`⏰ <strong>Avg assignment lag:</strong> ${lagNote} (${s.lagStats.count} dated tasks)`);
  }

  // Subcategory (task type) with highest average duration
  const subDurEntries = Object.entries(s.avgDurBySubcategory || {}).filter(([k]) => k !== 'Unspecified');
  if (subDurEntries.length > 0) {
    const [topSub, topDur] = subDurEntries.sort((a, b) => b[1] - a[1])[0];
    if (topDur > 0) items.push(`🔍 <strong>Longest task type:</strong> ${esc(topSub)} (avg ${topDur}m)`);
  }

  // Most common flag–source-group combination
  const flagCatPairs = Object.entries(s.byFlagByCategory || {}).flatMap(([f, cats]) =>
    Object.entries(cats).map(([c, n]) => ({ flag: f, cat: c, n }))
  );
  if (flagCatPairs.length > 0) {
    const top = flagCatPairs.sort((a, b) => b.n - a.n)[0];
    items.push(`🚩 <strong>Top flag source:</strong> "${esc(top.flag)}" from ${esc(top.cat)}`);
  }

  return items;
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

function toggleAnalyticsTasks() {
  state.analyticsTasksExpanded = !state.analyticsTasksExpanded;
  if (state.analyticsData) {
    clearCharts();
    renderAnalyticsContent(state.analyticsData.data, state.analyticsData.mode, state.analyticsData.pendingLog);
  }
}

function toggleAnalyticsFilters() {
  state.analyticsFiltersExpanded = !state.analyticsFiltersExpanded;
  if (state.analyticsData) {
    clearCharts();
    renderAnalyticsContent(state.analyticsData.data, state.analyticsData.mode, state.analyticsData.pendingLog);
  }
}

async function downloadExport() {
  window.location.href = '/api/analytics/export';
}

function exportAnalyticsPdf() {
  if (!state.analyticsData) return;
  const s = state.analyticsData.data.summary;
  const mode = state.analyticsData.mode;

  // Build a human-readable period label
  const from = state.analyticsFilterFrom || state.analyticsQuickFrom || '';
  const to   = state.analyticsFilterTo   || state.analyticsQuickTo   || '';
  const qp   = state.analyticsQuickPeriod;
  const fmtDate = d => {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    return `${parseInt(day)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m)-1]} ${y}`;
  };
  let periodLabel;
  if (mode === 'session' || qp === 'today') {
    periodLabel = `Today — ${fmtDate(from || new Date().toISOString().split('T')[0])}`;
  } else if (qp === '7d') {
    periodLabel = `Last 7 Days — ${fmtDate(from)} to ${fmtDate(to)}`;
  } else if (qp === '30d') {
    periodLabel = `Last 30 Days — ${fmtDate(from)} to ${fmtDate(to)}`;
  } else if (from || to) {
    periodLabel = [fmtDate(from), fmtDate(to)].filter(Boolean).join(' – ');
  } else {
    periodLabel = 'All Data';
  }

  // Map canvas IDs to readable chart titles
  const chartTitleMap = {
    'chart-cat':             'Time by Category (mins)',
    'chart-split':           'My Group vs Personal',
    'chart-outcome':         'Outcome Distribution',
    'chart-outcome-cat':     'Outcome Breakdown by Category',
    'chart-cat-dur':         'Avg Duration by Category (mins)',
    'chart-sub':             'Tasks by Type',
    'chart-sub-dur':         'Avg Duration by Task Type (mins)',
    'chart-cat-sub':         'Task Types by Source Group',
    'chart-flags':           'Task Flag Distribution',
    'chart-flag-cat':        'Flags by Source Group',
    'chart-hour':            'Activity by Hour of Day',
    'chart-dow':             'Activity by Day of Week',
    'chart-dow-sub':         'Task Type Patterns by Day Assigned',
    'chart-personal-dow-cat':'Personal Tasks by Day Assigned — by Task Origin',
    'chart-personal-dow-sub':'Personal Tasks by Day Assigned — by Task Type',
    'chart-trend':           'Tasks & Time Over Time',
    'chart-intr-trend':      'Interruptions Over Time',
    'chart-lag':             'Days from Assignment to Action',
  };

  // Capture each active chart in the order they appear in the DOM
  const canvasOrder = Array.from(document.querySelectorAll('canvas[id^="chart-"]')).map(c => c.id);
  const chartSections = canvasOrder
    .filter(id => state.charts[id])
    .map(id => {
      const title = chartTitleMap[id] || id;
      const imgSrc = state.charts[id].toBase64Image('image/png', 1);
      return `<div class="chart-block">
        <h2>${title}</h2>
        <img src="${imgSrc}" alt="${title}">
      </div>`;
    }).join('\n');

  const generated = new Date().toLocaleString();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Analytics Report — ${periodLabel}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a2e; background: #fff; padding: 24px; font-size: 14px; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #6b7280; font-size: 0.85rem; margin-bottom: 4px; }
    .generated { color: #9ca3af; font-size: 0.75rem; margin-bottom: 20px; }
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 24px; }
    .stat-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; text-align: center; }
    .stat-number { font-size: 1.4rem; font-weight: 700; color: #1a56db; }
    .stat-label { font-size: 0.7rem; color: #6b7280; margin-top: 2px; }
    .chart-block { page-break-inside: avoid; break-inside: avoid; margin-bottom: 28px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
    .chart-block h2 { font-size: 0.95rem; font-weight: 600; margin-bottom: 12px; color: #1a1a2e; }
    .chart-block img { width: 100%; height: auto; display: block; }
    @media print {
      body { padding: 0; }
      .stats-grid { page-break-inside: avoid; break-inside: avoid; }
      .chart-block { page-break-inside: avoid; break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>📊 Analytics Report</h1>
  <p class="subtitle">${periodLabel}</p>
  <p class="generated">Generated: ${generated}</p>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-number">${s.total}</div><div class="stat-label">Total tasks</div></div>
    <div class="stat-card"><div class="stat-number">${s.totalMins}</div><div class="stat-label">Total mins</div></div>
    <div class="stat-card"><div class="stat-number">${s.avgDurMins ?? 0}</div><div class="stat-label">Avg mins/task</div></div>
    <div class="stat-card"><div class="stat-number">${s.dutyCount}</div><div class="stat-label">My Group tasks</div></div>
    <div class="stat-card"><div class="stat-number">${s.personalCount}</div><div class="stat-label">Personal</div></div>
    <div class="stat-card"><div class="stat-number">${s.totalInterruptions || 0}</div><div class="stat-label">Interruptions</div></div>
    <div class="stat-card"><div class="stat-number">${s.avgInterruptionsPerTask ?? 0}</div><div class="stat-label">Avg intr/task</div></div>
    <div class="stat-card"><div class="stat-number">${s.tasksWithFlags ?? 0}</div><div class="stat-label">Flagged tasks</div></div>
  </div>
  ${chartSections || '<p style="color:#6b7280;text-align:center;padding:20px">No charts to display.</p>'}
</body>
</html>`;

  const printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) { showAlert('Pop-up blocked. Please allow pop-ups for this site to generate the PDF.'); return; }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.addEventListener('load', () => {
    printWindow.focus();
    printWindow.print();
  });
}

// ── ADMIN ────────────────────────────────────────────────────────────────────
async function renderAdmin() {
  stopTimer(); clearCharts(); state.currentView = 'admin';
  pushHistory('admin');
  app().innerHTML = `<div class="view"><p class="loading">Loading admin panel…</p></div>`;
  try {
    const [stats, users, dropOpts, settings, pendingUsers, awaitingUsers, userGroups, pendingGroups, smtpSettings, notices, flagOpts, proposals, twoFaSettings] = await Promise.all([
      api('GET', '/api/admin/stats'),
      api('GET', '/api/admin/users'),
      api('GET', '/api/dropdowns/admin/all'),
      api('GET', '/api/admin/settings'),
      api('GET', '/api/admin/pending-users'),
      api('GET', '/api/admin/awaiting-activation'),
      api('GET', '/api/admin/user-groups'),
      api('GET', '/api/admin/pending-groups'),
      api('GET', '/api/admin/smtp'),
      api('GET', '/api/admin/notices'),
      api('GET', '/api/flags/admin/all'),
      api('GET', '/api/admin/dropdown-proposals'),
      api('GET', '/api/admin/2fa'),
    ]);
    if (!stats || !users || !dropOpts || !settings || !pendingUsers || !awaitingUsers || !userGroups || !pendingGroups) return;
    renderAdminContent(stats, users?.users || [], dropOpts?.options || [], settings, pendingUsers?.users || [], awaitingUsers?.users || [], userGroups?.groups || [], pendingGroups?.groups || [], smtpSettings || {}, notices?.notices || [], flagOpts?.options || [], proposals?.proposals || [], twoFaSettings || {});
  } catch(e) {
    app().innerHTML = `<div class="view"><div id="admin-alerts"></div></div>`;
    showAlert(e.message, 'error', 'admin-alerts');
  }
}

function renderAdminContent(stats, users, dropOpts, settings, pendingUsers, awaitingUsers, userGroups, pendingGroups, smtpSettings, notices, flagOpts, proposals, twoFaSettings) {
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
      <div style="display:flex;gap:4px">
        <button class="btn btn-outline btn-sm" onclick="renameDropdown(${o.id}, '${esc(o.value)}')">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteDropdown(${o.id})">✕</button>
      </div>
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

  // Dropdown proposals are now metadata-only (email-based); show pending proposal count
  const proposalCards = proposals.length ? proposals.map(p => `
  <div class="card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <span style="font-size:.8rem;color:#6b7280">${esc(p.field_name)}</span>
        <span style="font-size:.75rem;color:#6b7280;display:block;margin-top:2px">Submitted ${new Date(p.created_at+'Z').toLocaleString()}</span>
        ${p.review_token ? `<a href="/suggest/review?token=${p.review_token}" target="_blank" class="btn btn-outline btn-sm" style="margin-top:6px;display:inline-block">🔗 Review suggestion</a>` : ''}
      </div>
      <button class="btn btn-outline btn-sm" onclick="dismissProposal(${p.id})">✓ Done</button>
    </div>
  </div>`).join('') : '<p style="font-size:.85rem;color:#6b7280">No pending email proposals.</p>';

  // Flag options section
  const flagOptionItems = flagOpts.map(f => `
  <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6">
    <span style="font-size:.9rem">${esc(f.value)}</span>
    <div style="display:flex;gap:4px">
      <button class="btn btn-outline btn-sm" onclick="renameFlagOption(${f.id})">✏️</button>
      <button class="btn btn-danger btn-sm" onclick="deleteFlagOption(${f.id})">✕</button>
    </div>
  </div>`).join('');

  // Notices section
  const noticeItems = notices.map(n => `
  <div class="card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
      <div style="flex:1">
        <p style="font-size:.9rem;color:#374151;margin-bottom:4px">${esc(n.message)}</p>
        <span style="font-size:.75rem;color:#6b7280">${n.active ? '✅ Active' : '⏸️ Inactive'} · ${new Date(n.created_at+'Z').toLocaleDateString()}</span>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="btn btn-outline btn-sm" onclick="editNotice(${n.id})">✏️</button>
        <button class="btn ${n.active ? 'btn-secondary' : 'btn-primary'} btn-sm" onclick="toggleNotice(${n.id}, ${n.active})">${n.active ? 'Deactivate' : 'Activate'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteNotice(${n.id})">✕</button>
      </div>
    </div>
  </div>`).join('');

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

  const groupCards = userGroups.map(g => `
  <div class="card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <span style="font-weight:700">${esc(g.name)}</span>
        <span style="font-size:.75rem;color:#6b7280;margin-left:6px">${g.user_count} user${g.user_count !== 1 ? 's' : ''}</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="showGroupDropdownModal(${g.id}, '${esc(g.name)}')">⚙️ Options</button>
        <button class="btn btn-outline btn-sm" onclick="renameUserGroup(${g.id}, '${esc(g.name)}')">✏️ Rename</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUserGroup(${g.id}, '${esc(g.name)}')">🗑</button>
      </div>
    </div>
  </div>`).join('');

  app().innerHTML = `
  <div class="view view--wide">
    <div class="view-header">
      <h1>🔐 Admin Panel</h1>
    </div>
    <div id="admin-alerts"></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-number">${stats?.userCount ?? '?'}</div><div class="stat-label">Registered users</div></div>
      <div class="stat-card"><div class="stat-number">${stats?.taskCount ?? '?'}</div><div class="stat-label">Tasks logged</div></div>
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

    <div class="admin-desktop-grid">
      <div>
        <div class="section-heading">Pending User Approvals ${pendingUsers.length ? `<span class="badge badge-warn" style="margin-left:6px">${pendingUsers.length}</span>` : ''}</div>
        ${pendingUserCards}

        <div class="section-heading">Awaiting Activation ${awaitingUsers.length ? `<span class="badge badge-warn" style="margin-left:6px">${awaitingUsers.length}</span>` : ''}</div>
        ${awaitingUserCards}

        <div class="section-heading">Users</div>
        <button class="btn btn-primary btn-full" style="margin-bottom:14px" onclick="addUser()">➕ Add User</button>
        ${userCards || '<p style="font-size:.85rem;color:#6b7280;margin-bottom:14px">No users yet.</p>'}
      </div>

      <div>
        <div class="section-heading">User Groups</div>
        <p style="font-size:.85rem;color:#6b7280;margin-bottom:10px">Groups control which dropdown options users see. Users select their own group for privacy reasons.</p>
        <button class="btn btn-primary btn-full" style="margin-bottom:14px" onclick="addUserGroup()">➕ Add User Group</button>
        ${groupCards || '<p style="font-size:.85rem;color:#6b7280;margin-bottom:14px">No user groups yet.</p>'}
      </div>
    </div>

    <div class="section-heading">Dropdown Options</div>
    <div class="admin-drop-grid">
      ${dropSections}
    </div>

    <div class="section-heading">Pending Email Proposals ${proposals.length ? `<span class="badge badge-warn" style="margin-left:6px">${proposals.length}</span>` : ''}</div>
    <p style="font-size:.85rem;color:#6b7280;margin-bottom:10px">A dropdown suggestion was emailed to you with a review link. Click "Review suggestion" to open the dedicated page and enter the approved wording. Mark as done once handled.</p>
    ${proposalCards}

    <div class="section-heading">Pending Group Proposals ${pendingGroups.length ? `<span class="badge badge-warn" style="margin-left:6px">${pendingGroups.length}</span>` : ''}</div>
    ${pendingGroups.length ? pendingGroups.map(g => `
    <div class="card" style="padding:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-size:.8rem;color:#6b7280">User group</span>
          <span style="font-weight:700;margin-left:8px">${esc(g.name)}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary btn-sm" onclick="approvePendingGroup(${g.id})">✓ Approve</button>
          <button class="btn btn-danger btn-sm" onclick="rejectPendingGroup(${g.id})">✗ Reject</button>
        </div>
      </div>
    </div>`).join('') : '<p style="font-size:.85rem;color:#6b7280">No pending group suggestions.</p>'}

    <div class="section-heading">Task Flag Options</div>
    <p style="font-size:.85rem;color:#6b7280;margin-bottom:10px">Flags allow users to annotate tasks with one or more issues. Users can suggest new flags via email.</p>
    <div class="card">
      ${flagOptionItems || '<p style="font-size:.85rem;color:#6b7280">No flag options.</p>'}
      <div class="add-new-row" style="margin-top:10px">
        <input id="add-flag" class="input" type="text" placeholder="New flag option…">
        <button class="btn btn-outline btn-sm" onclick="addFlagOption()">Add</button>
      </div>
    </div>

    <div class="section-heading">Notices</div>
    <p style="font-size:.85rem;color:#6b7280;margin-bottom:10px">Active notices are shown on users' home screen.</p>
    ${noticeItems || '<p style="font-size:.85rem;color:#6b7280;margin-bottom:10px">No notices yet.</p>'}
    <div class="card">
      <textarea id="new-notice-text" class="textarea" placeholder="Type a notice to display to all users…" style="margin-bottom:8px"></textarea>
      <button class="btn btn-primary btn-full" onclick="createNotice()">📢 Post Notice</button>
    </div>

    <div class="section-heading">SMTP Email Settings</div>
    <p style="font-size:.85rem;color:#6b7280;margin-bottom:10px">Required for sending dropdown suggestions by email instead of storing them on the server.</p>
    <div class="card">
      <div class="form-group">
        <label style="font-size:.9rem">SMTP Host</label>
        <input id="smtp-host" class="input" type="text" value="${esc(smtpSettings.host || '')}" placeholder="e.g. smtp.nhs.net" style="margin-top:4px">
      </div>
      <div style="display:flex;gap:10px;margin-top:10px">
        <div class="form-group" style="flex:1">
          <label style="font-size:.9rem">Port</label>
          <input id="smtp-port" class="input" type="number" value="${smtpSettings.port || 587}" placeholder="587" style="margin-top:4px">
        </div>
        <div class="form-group" style="flex:1">
          <label style="font-size:.9rem">Use TLS/SSL</label>
          <select id="smtp-secure" class="input" style="margin-top:4px">
            <option value="false" ${smtpSettings.secure !== 'true' ? 'selected' : ''}>STARTTLS (port 587)</option>
            <option value="true"  ${smtpSettings.secure === 'true'  ? 'selected' : ''}>SSL/TLS (port 465)</option>
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label style="font-size:.9rem">SMTP Username</label>
        <input id="smtp-user" class="input" type="text" value="${esc(smtpSettings.user || '')}" autocomplete="off" style="margin-top:4px">
      </div>
      <div class="form-group" style="margin-top:10px">
        <label style="font-size:.9rem">SMTP Password ${smtpSettings.hasPass ? '<span style="color:#059669">(saved)</span>' : ''}</label>
        <input id="smtp-pass" class="input" type="password" placeholder="${smtpSettings.hasPass ? 'Leave blank to keep existing' : 'Enter password'}" autocomplete="new-password" style="margin-top:4px">
      </div>
      <div class="form-group" style="margin-top:10px">
        <label style="font-size:.9rem">From address</label>
        <input id="smtp-from" class="input" type="email" value="${esc(smtpSettings.from || '')}" placeholder="tasker@example.com" style="margin-top:4px">
      </div>
      <div class="form-group" style="margin-top:10px">
        <label style="font-size:.9rem">Send suggestions to (your NHS email)</label>
        <input id="smtp-to" class="input" type="email" value="${esc(smtpSettings.to || '')}" placeholder="you@nhs.net" style="margin-top:4px">
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" style="flex:1" onclick="saveSmtpSettings()">💾 Save SMTP Settings</button>
        <button class="btn btn-outline" onclick="testSmtp()">🔧 Test</button>
      </div>
      <div id="smtp-alerts" style="margin-top:8px"></div>
    </div>

    <div class="section-heading">Admin Two-Factor Authentication (2FA)</div>
    <p style="font-size:.85rem;color:#6b7280;margin-bottom:10px">When enabled, a one-time verification code is sent to your admin email address each time you log in. The primary email address is taken from the SMTP "Send suggestions to" field above.</p>
    <div class="card">
      <div class="form-group">
        <label style="font-size:.9rem">Primary admin email</label>
        <input class="input" type="text" value="${esc(twoFaSettings.primaryEmail || '')}" disabled style="margin-top:4px;background:#f3f4f6;color:#6b7280">
        <p style="font-size:.75rem;color:#6b7280;margin-top:4px">Set in SMTP settings above (the "Send suggestions to" field).</p>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label style="font-size:.9rem">Backup email address <span style="font-weight:400;color:#6b7280">(optional)</span></label>
        <input id="tfa-backup-email" class="input" type="email" value="${esc(twoFaSettings.backupEmail || '')}" placeholder="backup@example.com" style="margin-top:4px">
        <p style="font-size:.75rem;color:#6b7280;margin-top:4px">Codes will also be sent here. Useful if the primary address is unavailable.</p>
      </div>
      <div class="form-group" style="margin-top:12px;display:flex;align-items:center;gap:10px">
        <input id="tfa-enabled" type="checkbox" ${twoFaSettings.enabled ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0">
        <label for="tfa-enabled" style="font-size:.9rem;font-weight:400">Enable 2FA for admin login</label>
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:12px" onclick="save2faSettings()">🔒 Save 2FA Settings</button>
      <div id="tfa-admin-alerts" style="margin-top:8px"></div>
    </div>

    <div class="admin-desktop-grid" style="margin-top:0">
      <div>
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
      </div>
      <div>
        <div class="section-heading">My Account</div>
        <div class="card">
          <button class="btn btn-outline btn-full" onclick="renderChangePassword()">🔑 Change My Password</button>
        </div>
      </div>
    </div>

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

async function approvePendingGroup(groupId) {
  try {
    await api('POST', `/api/admin/pending-groups/${groupId}/approve`, {});
    showAlert('Group approved and added to available groups.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function rejectPendingGroup(groupId) {
  try {
    await api('DELETE', `/api/admin/pending-groups/${groupId}`, {});
    showAlert('Group suggestion rejected.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function renameDropdown(id, currentValue) {
  const newValue = prompt(`Rename "${currentValue}" to:`, currentValue);
  if (!newValue || newValue.trim() === currentValue) return;
  try {
    await api('PUT', `/api/dropdowns/admin/${id}`, { value: newValue.trim() });
    showAlert(`Renamed to: ${newValue.trim()}`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

// ── Admin SMTP, notices, flags, proposals ─────────────────────────────────────

async function saveSmtpSettings() {
  const body = {
    host:   document.getElementById('smtp-host')?.value || '',
    port:   document.getElementById('smtp-port')?.value || '587',
    secure: document.getElementById('smtp-secure')?.value || 'false',
    user:   document.getElementById('smtp-user')?.value || '',
    pass:   document.getElementById('smtp-pass')?.value || undefined,
    from:   document.getElementById('smtp-from')?.value || '',
    to:     document.getElementById('smtp-to')?.value || '',
  };
  if (!body.pass) delete body.pass;
  try {
    await api('POST', '/api/admin/smtp', body);
    showAlert('SMTP settings saved.', 'success', 'smtp-alerts');
  } catch(e) { showAlert(e.message, 'error', 'smtp-alerts'); }
}

async function testSmtp() {
  try {
    await api('POST', '/api/admin/smtp/test', {});
    showAlert('Test email sent successfully!', 'success', 'smtp-alerts');
  } catch(e) { showAlert(e.message, 'error', 'smtp-alerts'); }
}

async function save2faSettings() {
  const enabled = document.getElementById('tfa-enabled')?.checked ?? false;
  const backupEmail = document.getElementById('tfa-backup-email')?.value.trim() || '';
  try {
    await api('POST', '/api/admin/2fa', { enabled, backupEmail });
    showAlert('2FA settings saved.', 'success', 'tfa-admin-alerts');
  } catch(e) { showAlert(e.message, 'error', 'tfa-admin-alerts'); }
}

async function createNotice() {
  const msg = document.getElementById('new-notice-text')?.value.trim();
  if (!msg) return;
  try {
    await api('POST', '/api/admin/notices', { message: msg });
    showAlert('Notice posted.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function editNotice(id) {
  const notice = state.notices.find(n => n.id === id);
  if (!notice) return;
  const newMsg = prompt('Edit notice:', notice.message);
  if (!newMsg || newMsg.trim() === notice.message) return;
  try {
    await api('PUT', `/api/admin/notices/${id}`, { message: newMsg.trim() });
    showAlert('Notice updated.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function toggleNotice(id, currentlyActive) {
  try {
    await api('PUT', `/api/admin/notices/${id}`, { active: !currentlyActive });
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function deleteNotice(id) {
  if (!confirm('Delete this notice?')) return;
  try {
    await api('DELETE', `/api/admin/notices/${id}`, {});
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function addFlagOption() {
  const val = document.getElementById('add-flag')?.value.trim();
  if (!val) return;
  try {
    await api('POST', '/api/flags/admin', { value: val });
    showAlert('Flag option added.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function renameFlagOption(id) {
  const opt = state.flagOptions.find(f => f.id === id);
  if (!opt) return;
  const currentValue = opt.value;
  const newValue = prompt(`Rename "${currentValue}" to:`, currentValue);
  if (!newValue || newValue.trim() === currentValue) return;
  try {
    await api('PUT', `/api/flags/admin/${id}`, { value: newValue.trim() });
    showAlert(`Flag renamed to: ${newValue.trim()}`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function deleteFlagOption(id) {
  if (!confirm('Delete this flag option? It will be removed from all tasks.')) return;
  try {
    await api('DELETE', `/api/flags/admin/${id}`, {});
    showAlert('Flag option deleted.', 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function dismissProposal(id) {
  try {
    await api('DELETE', `/api/admin/dropdown-proposals/${id}`, {});
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

// ── Admin User Group management ───────────────────────────────────────────────

async function addUserGroup() {
  const name = prompt('Enter a name for the new user group:');
  if (!name || !name.trim()) return;
  try {
    await api('POST', '/api/admin/user-groups', { name: name.trim() });
    showAlert(`User group "${name.trim()}" created.`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function renameUserGroup(id, currentName) {
  const newName = prompt(`Rename group "${currentName}" to:`, currentName);
  if (!newName || newName.trim() === currentName) return;
  try {
    await api('PUT', `/api/admin/user-groups/${id}`, { name: newName.trim() });
    showAlert(`Group renamed to: ${newName.trim()}`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function deleteUserGroup(id, name) {
  if (!confirm(`Delete user group "${name}"? Users assigned to this group will have their group removed.`)) return;
  try {
    await api('DELETE', `/api/admin/user-groups/${id}`, {});
    showAlert(`Group "${name}" deleted.`, 'success', 'admin-alerts');
    renderAdmin();
  } catch(e) { showAlert(e.message, 'error', 'admin-alerts'); }
}

async function showGroupDropdownModal(groupId, groupName) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'group-dd-modal';
  modal.innerHTML = `<div class="modal-sheet">
    <div class="modal-body"><div class="modal-title">⚙️ Options for ${esc(groupName)}</div><p class="loading">Loading…</p></div>
    <div class="modal-footer"><button class="btn btn-secondary" style="flex:1" onclick="document.getElementById('group-dd-modal')?.remove()">Cancel</button></div>
  </div>`;
  document.body.appendChild(modal);
  try {
    const d = await api('GET', `/api/admin/user-groups/${groupId}/dropdowns`);
    const byField = {};
    for (const o of (d?.options || [])) {
      if (!byField[o.field_name]) byField[o.field_name] = [];
      byField[o.field_name].push(o);
    }
    const fieldLabels = { category: 'Task from', subcategory: 'Task type', outcome: 'Outcome' };
    const sections = ['category', 'subcategory', 'outcome'].map(field => {
      const opts = (byField[field] || []).map(o => `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6;cursor:pointer">
          <input type="checkbox" name="group-opt-${groupId}" value="${o.id}" ${o.assigned ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0">
          <span style="font-size:.9rem">${esc(o.value)}</span>
        </label>`).join('');
      return `<div style="margin-bottom:16px">
        <div style="font-weight:700;color:#374151;margin-bottom:4px;font-size:.9rem">${fieldLabels[field]}</div>
        ${opts || '<p style="font-size:.85rem;color:#6b7280">No options available</p>'}
      </div>`;
    }).join('');
    modal.querySelector('.modal-body').innerHTML = `
      <div class="modal-title">⚙️ Options for ${esc(groupName)}</div>
      <p style="font-size:.85rem;color:#6b7280;margin-bottom:16px">Tick the options that should appear in dropdown lists for users in this group.</p>
      ${sections || '<p style="color:#6b7280">No dropdown options exist yet.</p>'}`;
    modal.querySelector('.modal-footer').innerHTML = `
      <button class="btn btn-primary" style="flex:1" onclick="saveGroupDropdowns(${groupId})">💾 Save</button>
      <button class="btn btn-secondary" style="flex:1" onclick="document.getElementById('group-dd-modal')?.remove()">Cancel</button>`;
  } catch(e) {
    modal.querySelector('.modal-body').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    modal.querySelector('.modal-footer').innerHTML = `<button class="btn btn-secondary btn-full" onclick="document.getElementById('group-dd-modal')?.remove()">Close</button>`;
  }
}

async function saveGroupDropdowns(groupId) {
  const checkboxes = document.querySelectorAll(`input[name="group-opt-${groupId}"]:checked`);
  const option_ids = Array.from(checkboxes).map(cb => Number(cb.value));
  try {
    await api('PUT', `/api/admin/user-groups/${groupId}/dropdowns`, { option_ids });
    showAlert('Group options saved.', 'success', 'admin-alerts');
    document.getElementById('group-dd-modal')?.remove();
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
  'group-selection':    () => renderGroupSelection(() => renderHome()),
  'my-options':         () => openMyOptionsModal(), // restores options UI with return-to-settings callback
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
  'group-selection', 'my-options', 'task-start', 'task-active', 'task-end', 'task-edit',
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
    // On every foreground resume, check whether a new app version has been deployed.
    // Throttled to once per 60 s to avoid redundant fetches when the user rapidly
    // switches apps.  checkAssetVersion() itself records the timestamp, so the
    // periodic poll (Option 2) and this path share the same cooldown.
    if (Date.now() - _lastVersionCheckAt > VERSION_CHECK_DEBOUNCE_MS) {
      if (await checkAssetVersion()) return; // new version detected — update banner shown
    }
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
