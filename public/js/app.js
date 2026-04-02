/* Tasker — single-page client application */
'use strict';

/* ──────────────────────────────────────────────────────────
   STATE
────────────────────────────────────────────────────────── */
let currentUser = null; // { userId, username }
let allTasks    = [];   // cached task list
let editingId   = null; // task id being edited, or null for new
let csrfToken   = '';   // CSRF token fetched from server

/* ──────────────────────────────────────────────────────────
   BOOT
────────────────────────────────────────────────────────── */
(async function init() {
  // Fetch CSRF token first (required for all mutating requests)
  try {
    const data = await apiFetch('/api/csrf-token');
    csrfToken = data.csrfToken;
  } catch {
    console.error('Could not obtain CSRF token');
  }

  try {
    const me = await apiFetch('/api/auth/me');
    loginSuccess(me);
  } catch {
    showPage('login');
  }
})();

/* ──────────────────────────────────────────────────────────
   PAGE ROUTING
────────────────────────────────────────────────────────── */
function showPage(page) {
  document.getElementById('login-page').classList.toggle('hidden', page !== 'login');
  document.getElementById('dashboard-page').classList.toggle('hidden', page !== 'dashboard');
}

/* ──────────────────────────────────────────────────────────
   AUTH
────────────────────────────────────────────────────────── */
function showTab(tab) {
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  clearAlert('auth-alert');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  btn.disabled = true;
  btn.textContent = 'Signing in…';
  clearAlert('auth-alert');

  try {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    loginSuccess(data);
  } catch (err) {
    showAlert('auth-alert', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('register-btn');
  const username  = document.getElementById('reg-username').value.trim();
  const email     = document.getElementById('reg-email').value.trim();
  const password  = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;

  if (password !== password2) {
    showAlert('auth-alert', 'Passwords do not match.', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating account…';
  clearAlert('auth-alert');

  try {
    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    });
    loginSuccess(data);
  } catch (err) {
    showAlert('auth-alert', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
}

async function handleLogout() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  currentUser = null;
  allTasks = [];
  showPage('login');
  showTab('login');
}

function loginSuccess(data) {
  currentUser = data;
  document.getElementById('header-username').textContent = data.username;
  showPage('dashboard');
  loadTasks();
  loadMeta();
}

/* ──────────────────────────────────────────────────────────
   TASKS — load & render
────────────────────────────────────────────────────────── */
async function loadTasks() {
  try {
    allTasks = await apiFetch('/api/tasks');
    renderTasks();
  } catch (err) {
    console.error('Failed to load tasks', err);
  }
}

function renderTasks() {
  const search  = (document.getElementById('search-input').value || '').toLowerCase();
  const outcome = document.getElementById('filter-outcome').value;

  let filtered = allTasks.filter(t => {
    const matchOutcome = !outcome || t.outcome === outcome ||
      (outcome === 'in_progress' && !t.finish_time && !t.outcome);
    const matchSearch  = !search ||
      t.task_type.toLowerCase().includes(search) ||
      t.team.toLowerCase().includes(search) ||
      t.sender_initials.toLowerCase().includes(search) ||
      (t.notes && t.notes.toLowerCase().includes(search));
    return matchOutcome && matchSearch;
  });

  const list  = document.getElementById('task-list');
  const empty = document.getElementById('empty-state');

  list.innerHTML = '';

  if (filtered.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  filtered.forEach(task => {
    list.appendChild(buildTaskCard(task));
  });
}

function buildTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'task-card';

  const inProgress = !task.finish_time;
  const outcomeBadge = outcomeToDisplay(task.outcome, inProgress);

  card.innerHTML = `
    <div class="task-card-header">
      <span class="task-card-title">${esc(task.task_type)}</span>
      ${outcomeBadge}
    </div>
    <div class="task-card-meta">
      <span class="badge badge-gray">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
        </svg>
        ${esc(task.team)}
      </span>
      <span class="badge badge-gray">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px">
          <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/>
        </svg>
        ${esc(task.sender_initials)}
      </span>
      ${task.appropriate ? '' : '<span class="badge badge-warning">⚠ Inappropriate</span>'}
    </div>
    <div class="task-card-footer">
      <div class="task-time">
        ${inProgress ? '<span class="in-progress-dot"></span>' : ''}
        ${esc(task.start_time)}${task.finish_time ? ' → ' + esc(task.finish_time) : ' (in progress)'}
      </div>
      <div class="task-actions">
        <button class="btn btn-outline btn-sm" onclick="openModal(${task.id})" aria-label="Edit task">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTask(${task.id})" aria-label="Delete task">Del</button>
      </div>
    </div>
    ${task.notes ? `<div style="padding:0 1rem 0.75rem;font-size:0.8125rem;color:var(--gray-500);border-top:1px solid var(--gray-100);padding-top:0.5rem;">${esc(task.notes)}</div>` : ''}
  `;
  return card;
}

function outcomeToDisplay(outcome, inProgress) {
  if (inProgress && !outcome) {
    return '<span class="badge badge-warning">In progress</span>';
  }
  switch (outcome) {
    case 'actioned':                return '<span class="badge badge-success">Actioned</span>';
    case 'forwarded':               return '<span class="badge badge-primary">Forwarded</span>';
    case 'completed_without_action': return '<span class="badge badge-gray">Completed w/o action</span>';
    case 'in_progress':             return '<span class="badge badge-warning">In progress</span>';
    default:                        return '<span class="badge badge-gray">Pending</span>';
  }
}

/* ──────────────────────────────────────────────────────────
   META (task types + teams)
────────────────────────────────────────────────────────── */
async function loadMeta() {
  try {
    const [types, teams] = await Promise.all([
      apiFetch('/api/tasks/meta/types'),
      apiFetch('/api/tasks/meta/teams'),
    ]);
    populateDatalist('task-type-list', types);
    populateDatalist('team-list', teams);
  } catch { /* ignore */ }
}

function populateDatalist(id, items) {
  const dl = document.getElementById(id);
  dl.innerHTML = items.map(i => `<option value="${esc(i)}">`).join('');
}

/* ──────────────────────────────────────────────────────────
   MODAL
────────────────────────────────────────────────────────── */
function openModal(taskId) {
  editingId = taskId || null;
  clearAlert('modal-alert');
  resetForm();

  if (editingId) {
    const task = allTasks.find(t => t.id === editingId);
    if (task) populateForm(task);
    document.getElementById('modal-title-text').textContent = 'Edit Task';
    document.getElementById('save-task-btn').textContent = 'Update Task';
  } else {
    // Pre-fill start time with current time
    setNow('task-start');
    document.getElementById('modal-title-text').textContent = 'Log Task';
    document.getElementById('save-task-btn').textContent = 'Save Task';
  }

  document.getElementById('task-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('task-type').focus(), 50);
}

function closeModal() {
  document.getElementById('task-modal').classList.add('hidden');
  editingId = null;
}

function backdropClose(e) {
  if (e.target === document.getElementById('task-modal')) closeModal();
}

function resetForm() {
  document.getElementById('task-form').reset();
  document.getElementById('task-id').value = '';
  document.getElementById('task-appropriate').checked = true;
}

function populateForm(task) {
  document.getElementById('task-id').value = task.id;
  document.getElementById('task-type').value = task.task_type;
  document.getElementById('task-team').value = task.team;
  document.getElementById('task-sender').value = task.sender_initials;
  document.getElementById('task-start').value = task.start_time;
  document.getElementById('task-finish').value = task.finish_time || '';
  document.getElementById('task-appropriate').checked = task.appropriate !== 0;
  document.getElementById('task-notes').value = task.notes || '';

  if (task.outcome) {
    const radio = document.querySelector(`input[name="outcome"][value="${task.outcome}"]`);
    if (radio) radio.checked = true;
  }
}

async function handleTaskSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('save-task-btn');
  btn.disabled = true;
  clearAlert('modal-alert');

  const task_type       = document.getElementById('task-type').value.trim();
  const team            = document.getElementById('task-team').value.trim();
  const sender_initials = document.getElementById('task-sender').value.trim().toUpperCase();
  const start_time      = document.getElementById('task-start').value;
  const finish_time     = document.getElementById('task-finish').value;
  const appropriate     = document.getElementById('task-appropriate').checked;
  const notes           = document.getElementById('task-notes').value.trim();
  const outcomeEl       = document.querySelector('input[name="outcome"]:checked');
  const outcome         = outcomeEl ? outcomeEl.value : null;

  const payload = {
    task_type,
    team,
    sender_initials,
    start_time,
    finish_time: finish_time || null,
    outcome,
    appropriate,
    notes: notes || null,
  };

  try {
    if (editingId) {
      const updated = await apiFetch(`/api/tasks/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      allTasks = allTasks.map(t => t.id === editingId ? updated : t);
    } else {
      const created = await apiFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      allTasks.unshift(created);
    }
    closeModal();
    renderTasks();
    loadMeta(); // refresh autocomplete lists
  } catch (err) {
    showAlert('modal-alert', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' });
    allTasks = allTasks.filter(t => t.id !== id);
    renderTasks();
  } catch (err) {
    alert('Could not delete: ' + err.message);
  }
}

/* ──────────────────────────────────────────────────────────
   TIME HELPERS
────────────────────────────────────────────────────────── */
function setNow(fieldId) {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  document.getElementById(fieldId).value = `${hh}:${mm}`;
}

/* ──────────────────────────────────────────────────────────
   API HELPER
────────────────────────────────────────────────────────── */
async function apiFetch(url, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // Include CSRF token for all mutating requests
  if (options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(url, {
    headers,
    credentials: 'same-origin',
    ...options,
    // Merge headers properly in case caller passes their own
    headers: { ...headers, ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'An error occurred');
  return data;
}

/* ──────────────────────────────────────────────────────────
   UI HELPERS
────────────────────────────────────────────────────────── */
function showAlert(containerId, message, type = 'error') {
  const el = document.getElementById(containerId);
  el.innerHTML = `<div class="alert alert-${type}">${esc(message)}</div>`;
}

function clearAlert(containerId) {
  document.getElementById(containerId).innerHTML = '';
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Keyboard: close modal on Escape */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});
