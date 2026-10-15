const API = window.location.origin;
const TOKEN_KEY = 'joshikai_admin_token';

let token = localStorage.getItem(TOKEN_KEY) || '';
let selectedStatus = 'pending';
let selectedId = null;
let selectedUserId = null;
let activeTab = 'verifications';

const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const listEl = document.getElementById('list');
const detailEl = document.getElementById('detail');
const usersListEl = document.getElementById('users-list');
const userDetailEl = document.getElementById('user-detail');
const loginError = document.getElementById('login-error');
const dashTitle = document.getElementById('dash-title');
const dashSubtitle = document.getElementById('dash-subtitle');
const backBtn = document.getElementById('back-btn');
const verificationsListView = document.getElementById('verifications-list-view');
const usersListView = document.getElementById('users-list-view');

function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function displayName(row) {
  return (
    row.nickname ||
    row.name ||
    row.user?.nickname ||
    row.user?.name ||
    row.email ||
    'Unknown user'
  );
}

function normalizeImageUrl(raw) {
  let s = String(raw || '').trim().replace(/^['"]+|['"]+$/g, '');
  if (!s) return '';
  if (s.startsWith('data:image')) return s;
  if (s.startsWith('//')) s = `https:${s}`;
  if (!/^https?:\/\//i.test(s) && /^[\w.-]+\.[a-z]{2,}/i.test(s)) {
    s = `https://${s}`;
  }
  return s;
}

function avatarSrc(row) {
  return normalizeImageUrl(row.profileImageUrl || row.selfieUrl || '');
}

/** Prefer proxied URL so hotlink-blocked images still show in admin. */
function displayAvatarUrl(raw) {
  const src = normalizeImageUrl(raw);
  if (!src) return '';
  if (src.startsWith('data:image')) return src;
  if (!/^https?:\/\//i.test(src)) return '';
  return `${API}/media/image?u=${encodeURIComponent(src)}`;
}

function appendAvatar(card, row) {
  const src = displayAvatarUrl(avatarSrc(row));
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Avatar';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.onerror = () => {
      img.replaceWith(letterAvatar(row));
    };
    card.appendChild(img);
  } else {
    card.appendChild(letterAvatar(row));
  }
}

function wireAvatarPreview(input, fallbackName) {
  const update = () => {
    const preview = document.getElementById('u-avatar-preview');
    const hint = document.getElementById('u-avatar-hint');
    if (!preview) return;
    const next = normalizeImageUrl(input.value);
    const display = displayAvatarUrl(next);
    if (!display) {
      if (hint) {
        hint.hidden = !input.value.trim();
        hint.textContent = input.value.trim()
          ? 'Use a direct image link (https://… ending in .jpg/.png, or Unsplash/Imgur).'
          : '';
      }
      return;
    }
    const applySrc = (imgEl) => {
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.onerror = () => {
        if (hint) {
          hint.hidden = false;
          hint.textContent =
            'Could not load that image. Use a direct image URL (not a Google/Drive share page).';
        }
      };
      imgEl.onload = () => {
        if (hint) {
          hint.hidden = true;
          hint.textContent = '';
        }
      };
      imgEl.src = display;
    };
    if (preview.tagName === 'IMG') {
      applySrc(preview);
    } else {
      const img = document.createElement('img');
      img.id = 'u-avatar-preview';
      img.className = 'selfie';
      img.alt = 'Avatar';
      applySrc(img);
      preview.replaceWith(img);
    }
  };
  input.addEventListener('input', update);
  input.addEventListener('change', update);
  update();
}

function letterAvatar(row) {
  const avatar = document.createElement('div');
  avatar.className = 'card-avatar';
  avatar.textContent = (displayName(row)[0] || '?').toUpperCase();
  return avatar;
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showDashboard() {
  if (loginView) {
    loginView.classList.add('view-hidden');
    loginView.setAttribute('hidden', '');
  }
  if (!dashboardView) {
    throw new Error('Dashboard element missing from page.');
  }
  dashboardView.classList.remove('view-hidden');
  dashboardView.removeAttribute('hidden');
  dashboardView.style.setProperty('display', 'flex', 'important');
  dashboardView.style.setProperty('opacity', '1', 'important');
  dashboardView.style.setProperty('visibility', 'visible', 'important');
  try {
    setTab(activeTab || 'verifications');
  } catch (err) {
    console.error('Dashboard tab error', err);
    if (detailEl) {
      detailEl.innerHTML = `<p class="error">Dashboard loaded, but the queue failed: ${escapeHtml(err.message || err)}</p>`;
    }
  }
  return window.getComputedStyle(dashboardView).display !== 'none';
}

function showLogin(clearToken = true) {
  if (clearToken) {
    token = '';
    localStorage.removeItem(TOKEN_KEY);
  }
  if (dashboardView) {
    dashboardView.classList.add('view-hidden');
    dashboardView.setAttribute('hidden', '');
    dashboardView.style.removeProperty('display');
    dashboardView.style.removeProperty('opacity');
    dashboardView.style.removeProperty('visibility');
  }
  if (loginView) {
    loginView.classList.remove('view-hidden');
    loginView.removeAttribute('hidden');
    loginView.style.setProperty('display', 'grid', 'important');
  }
  const btn = document.getElementById('admin-login-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

function statusBadge(status) {
  const s = String(status || 'pending').toLowerCase();
  const cls =
    s === 'approved'
      ? 'badge-approved'
      : s === 'rejected'
        ? 'badge-rejected'
        : 'badge-pending';
  return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
}

function showListMode() {
  if (activeTab === 'users') {
    selectedUserId = null;
    if (usersListView) usersListView.hidden = false;
    if (userDetailEl) {
      userDetailEl.hidden = true;
      userDetailEl.innerHTML = '';
    }
  } else {
    selectedId = null;
    if (verificationsListView) verificationsListView.hidden = false;
    if (detailEl) {
      detailEl.hidden = true;
      detailEl.innerHTML = '';
    }
  }
  if (backBtn) backBtn.hidden = true;
  if (dashSubtitle) {
    dashSubtitle.textContent =
      activeTab === 'users'
        ? 'Search and manage accounts'
        : 'Review pending ID checks';
  }
}

function showDetailMode(which) {
  if (which === 'users') {
    if (usersListView) usersListView.hidden = true;
    if (userDetailEl) userDetailEl.hidden = false;
  } else {
    if (verificationsListView) verificationsListView.hidden = true;
    if (detailEl) detailEl.hidden = false;
  }
  if (backBtn) backBtn.hidden = false;
}

function resetVerificationDetail() {
  showListMode();
}

function resetUserDetail() {
  showListMode();
}

function fillCardBody(card, title, lines, badgesHtml) {
  const body = document.createElement('div');
  body.className = 'card-body';
  body.innerHTML = `
    <p class="card-title">${escapeHtml(title)}</p>
    <div class="card-meta">${lines.map((l) => escapeHtml(l)).join('<br/>')}</div>
    <div class="card-foot">${badgesHtml}</div>
  `;
  card.appendChild(body);
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('verifications-pane').hidden = tab !== 'verifications';
  document.getElementById('users-pane').hidden = tab !== 'users';
  showListMode();
  if (tab === 'verifications') {
    dashTitle.textContent = 'Verifications';
    loadList();
  } else {
    dashTitle.textContent = 'Members';
    loadUsers();
  }
}

async function doAdminLogin(event) {
  if (event) event.preventDefault();
  if (loginError) loginError.hidden = true;
  const btn = document.getElementById('admin-login-btn');
  const email = document.getElementById('admin-email').value.trim();
  const password = document.getElementById('admin-password').value.trim();
  if (!email || !password) {
    if (loginError) {
      loginError.textContent = 'Please enter email and password.';
      loginError.hidden = false;
    }
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Signing in…';
  }
  try {
    const data = await api('/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (!data || !data.token) {
      throw new Error('Login succeeded but no token was returned.');
    }
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    const shown = showDashboard();
    if (!shown) {
      showLogin(false);
      throw new Error('Logged in, but dashboard stayed hidden. Hard-refresh (Ctrl+F5) and try again.');
    }
  } catch (e) {
    // Always bring login back so errors are visible (never leave a blank page).
    if (loginView?.classList.contains('view-hidden')) {
      showLogin(false);
    }
    const msg =
      e.message === 'Failed to fetch'
        ? 'Cannot reach the server. Is it running on this host:3000?'
        : e.message || 'Login failed';
    if (loginError) {
      loginError.textContent = msg;
      loginError.hidden = false;
    } else {
      window.alert(msg);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }
}

document.getElementById('admin-login-form')?.addEventListener('submit', doAdminLogin);
document.getElementById('admin-login-btn')?.addEventListener('click', (e) => {
  // Extra path if a browser blocks form submit for .local emails.
  e.preventDefault();
  doAdminLogin(e);
});

document.getElementById('logout-btn')?.addEventListener('click', showLogin);

backBtn?.addEventListener('click', () => {
  showListMode();
  if (activeTab === 'users') loadUsers();
  else loadList();
});

document.getElementById('refresh-btn')?.addEventListener('click', () => {
  if (activeTab === 'users') {
    if (selectedUserId != null) openUserDetail(selectedUserId);
    else loadUsers();
  } else if (selectedId != null) {
    openDetail(selectedId);
  } else {
    loadList();
  }
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedStatus = btn.dataset.status;
    resetVerificationDetail();
    loadList();
  });
});

document.getElementById('user-search-btn')?.addEventListener('click', () => loadUsers());
document.getElementById('user-search')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUsers();
});

async function loadList() {
  listEl.innerHTML = '<p class="muted list-empty">Loading…</p>';
  try {
    const rows = await api(
      `/id-verifications?status=${encodeURIComponent(selectedStatus)}&limit=50`,
    );
    if (!rows.length) {
      listEl.innerHTML = '<p class="muted list-empty">No submissions in this filter.</p>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach((row) => {
      const card = document.createElement('div');
      card.className = 'card';
      appendAvatar(card, row);
      fillCardBody(
        card,
        displayName(row),
        [row.email || 'No email', row.phoneNumber || 'No phone'],
        `${statusBadge(row.status)}<span class="badge badge-id">#${row.id}</span>`,
      );
      card.addEventListener('click', () => openDetail(row.id));
      listEl.appendChild(card);
    });
  } catch (e) {
    if (String(e.message).includes('401') || String(e.message).includes('Unauthorized')) {
      showLogin();
    } else {
      listEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    }
  }
}

async function openDetail(id) {
  selectedId = id;
  showDetailMode('verifications');
  detailEl.innerHTML = '<p class="muted">Loading…</p>';
  if (dashSubtitle) dashSubtitle.textContent = 'Review submission';
  try {
    const row = await api(`/id-verifications/${id}`);
    const interests = Array.isArray(row.interests) ? row.interests.join(', ') : '';
    const src = avatarSrc(row);
    const name = displayName(row);
    detailEl.innerHTML = `
      <div class="detail-hero">
      ${
        displayAvatarUrl(src)
          ? `<img class="selfie" src="${escapeHtml(displayAvatarUrl(src))}" alt="Avatar" referrerpolicy="no-referrer" />`
          : `<div class="detail-avatar-fallback">${escapeHtml((name[0] || '?').toUpperCase())}</div>`
      }
        <div class="copy">
          <h2>${escapeHtml(name)}</h2>
          <p class="muted">Submission #${row.id}</p>
          <div class="card-foot" style="margin-top:8px">${statusBadge(row.status)}</div>
        </div>
      </div>
      <div class="detail-section">
        <h3>Profile</h3>
        <dl>
          <dt>Email</dt><dd>${escapeHtml(row.email || '—')}</dd>
          <dt>Nickname</dt><dd>${escapeHtml(row.nickname || '—')}</dd>
          <dt>Name</dt><dd>${escapeHtml(row.name || '—')}</dd>
          <dt>Phone</dt><dd>${escapeHtml(row.phoneNumber || '—')}</dd>
          <dt>Life status</dt><dd>${escapeHtml(row.lifeStatus || '—')}</dd>
          <dt>Age</dt><dd>${escapeHtml(row.age || '—')}</dd>
          <dt>Place</dt><dd>${escapeHtml(row.placeOfLiving || '—')}</dd>
          <dt>Interests</dt><dd>${escapeHtml(interests || '—')}</dd>
          <dt>Submitted</dt><dd>${escapeHtml(row.submittedAt || '—')}</dd>
          <dt>Avatar URL</dt><dd class="url-wrap">${escapeHtml(row.profileImageUrl || row.selfieUrl || '—')}</dd>
        </dl>
      </div>
      <div class="detail-section">
        <h3>Note</h3>
        <label>Admin note
          <textarea id="admin-note" placeholder="Optional note">${escapeHtml(row.adminNote || '')}</textarea>
        </label>
      </div>
      <div class="actions">
        <button type="button" id="approve-btn" class="btn-primary">Approve</button>
        <button type="button" id="reject-btn" class="btn-soft">Reject</button>
        ${
          row.userId
            ? `<button type="button" id="goto-user-btn" class="btn-ghost">Open member</button>`
            : ''
        }
      </div>
    `;
    document.getElementById('approve-btn').onclick = () => patchStatus('approved');
    document.getElementById('reject-btn').onclick = () => patchStatus('rejected');
    const goto = document.getElementById('goto-user-btn');
    if (goto && row.userId) {
      goto.onclick = () => {
        setTab('users');
        openUserDetail(row.userId);
      };
    }
  } catch (e) {
    detailEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }
}

async function patchStatus(status) {
  const note = document.getElementById('admin-note')?.value || '';
  try {
    await api(`/id-verifications/${selectedId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, adminNote: note }),
    });
    resetVerificationDetail();
    await loadList();
  } catch (e) {
    alert(e.message);
  }
}

async function loadUsers() {
  usersListEl.innerHTML = '<p class="muted list-empty">Loading members…</p>';
  try {
    const q = document.getElementById('user-search')?.value?.trim() || '';
    const path = q
      ? `/admin/users?q=${encodeURIComponent(q)}`
      : '/admin/users';
    const rows = await api(path);
    if (!rows.length) {
      usersListEl.innerHTML = '<p class="muted list-empty">No members found.</p>';
      return;
    }
    usersListEl.innerHTML = '';
    rows.forEach((user) => {
      const card = document.createElement('div');
      card.className = 'card';
      appendAvatar(card, user);
      const placeAge = [user.placeOfLiving, user.age ? `age ${user.age}` : '']
        .filter(Boolean)
        .join(' · ');
      fillCardBody(
        card,
        displayName(user),
        [user.email || 'No email', placeAge || 'Location not set'],
        `${statusBadge(user.verificationStatus)}<span class="badge badge-id">#${user.id}</span>`,
      );
      card.addEventListener('click', () => openUserDetail(user.id));
      usersListEl.appendChild(card);
    });
  } catch (e) {
    if (String(e.message).includes('401') || String(e.message).includes('Unauthorized')) {
      showLogin();
    } else {
      usersListEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    }
  }
}

async function openUserDetail(id) {
  selectedUserId = id;
  showDetailMode('users');
  userDetailEl.innerHTML = '<p class="muted">Loading…</p>';
  if (dashSubtitle) dashSubtitle.textContent = 'Edit member';
  try {
    const data = await api(`/admin/users/${id}`);
    const user = data.user || data;
    const interests = Array.isArray(user.interests) ? user.interests.join(', ') : '';
    const status = user.verificationStatus || 'pending';
    const img = avatarSrc(user);
    const displayImg = displayAvatarUrl(img);
    const name = displayName(user);
    userDetailEl.innerHTML = `
      <div class="detail-hero">
        ${
          displayImg
            ? `<img id="u-avatar-preview" class="selfie" src="${escapeHtml(displayImg)}" alt="Avatar" referrerpolicy="no-referrer" />`
            : `<div id="u-avatar-preview" class="detail-avatar-fallback">${escapeHtml((name[0] || '?').toUpperCase())}</div>`
        }
        <div class="copy">
          <h2>${escapeHtml(name)}</h2>
          <p class="muted">${escapeHtml(user.email || '')}</p>
          <div class="card-foot" style="margin-top:8px">${statusBadge(status)}<span class="badge badge-id">#${user.id}</span></div>
        </div>
      </div>
      <div class="detail-section">
        <h3>Edit profile</h3>
        <div class="form-grid">
          <label class="full">Avatar URL
            <input id="u-avatar" type="text" value="${escapeHtml(user.profileImageUrl || '')}" placeholder="https://images.unsplash.com/photo-….jpg" />
            <span id="u-avatar-hint" class="field-hint error" hidden></span>
          </label>
          <label>Email<input id="u-email" type="email" value="${escapeHtml(user.email || '')}" /></label>
          <label>Nickname<input id="u-nickname" value="${escapeHtml(user.nickname || '')}" /></label>
          <label>Name<input id="u-name" value="${escapeHtml(user.name || '')}" /></label>
          <label>Phone<input id="u-phone" value="${escapeHtml(user.phoneNumber || '')}" /></label>
          <label>Age<input id="u-age" type="number" min="0" value="${escapeHtml(user.age || 0)}" /></label>
          <label>Life status
            <select id="u-life">
              <option value="student" ${user.lifeStatus === 'student' ? 'selected' : ''}>student</option>
              <option value="working" ${user.lifeStatus === 'working' ? 'selected' : ''}>working</option>
              <option value="other" ${!['student', 'working'].includes(user.lifeStatus) ? 'selected' : ''}>other</option>
            </select>
          </label>
          <label class="full">Place of living<input id="u-place" value="${escapeHtml(user.placeOfLiving || '')}" /></label>
          <label class="full">Interests (comma-separated)<input id="u-interests" value="${escapeHtml(interests)}" /></label>
          <label class="full">Bio<textarea id="u-bio" placeholder="A short note about them">${escapeHtml(user.bio || '')}</textarea></label>
          <label>Verification status
            <select id="u-status">
              <option value="pending" ${status === 'pending' ? 'selected' : ''}>pending</option>
              <option value="approved" ${status === 'approved' ? 'selected' : ''}>approved</option>
              <option value="rejected" ${status === 'rejected' ? 'selected' : ''}>rejected</option>
            </select>
          </label>
        </div>
      </div>
      <p id="user-msg" class="success" hidden></p>
      <p id="user-err" class="error" hidden></p>
      <div class="actions">
        <button type="button" id="save-user-btn" class="btn-primary">Save changes</button>
        <button type="button" id="reset-pw-btn" class="btn-soft">Reset password</button>
        <button type="button" id="delete-user-btn" class="danger">Delete member</button>
      </div>
    `;
    document.getElementById('save-user-btn').onclick = () => saveUser(user.id);
    document.getElementById('reset-pw-btn').onclick = () => resetPassword(user.id, user.email);
    document.getElementById('delete-user-btn').onclick = () => deleteUser(user.id, displayName(user));
    const avatarInput = document.getElementById('u-avatar');
    if (avatarInput) wireAvatarPreview(avatarInput, name);
  } catch (e) {
    userDetailEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }
}

function showUserMsg(text, isError = false) {
  const ok = document.getElementById('user-msg');
  const err = document.getElementById('user-err');
  if (!ok || !err) return;
  ok.hidden = isError || !text;
  err.hidden = !isError || !text;
  if (isError) err.textContent = text;
  else ok.textContent = text;
}

async function saveUser(id) {
  showUserMsg('');
  const interestsRaw = document.getElementById('u-interests').value || '';
  const interests = interestsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
  try {
    const avatarUrl = normalizeImageUrl(
      document.getElementById('u-avatar').value,
    );
    const saved = await api(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        profileImageUrl: avatarUrl,
        email: document.getElementById('u-email').value.trim(),
        nickname: document.getElementById('u-nickname').value.trim(),
        name: document.getElementById('u-name').value.trim(),
        phoneNumber: document.getElementById('u-phone').value.trim(),
        age: Number(document.getElementById('u-age').value) || 0,
        lifeStatus: document.getElementById('u-life').value,
        placeOfLiving: document.getElementById('u-place').value.trim(),
        interests,
        bio: document.getElementById('u-bio').value.trim(),
        verificationStatus: document.getElementById('u-status').value,
      }),
    });
    const savedUrl = saved?.user?.profileImageUrl || avatarUrl;
    showUserMsg(
      savedUrl
        ? 'Saved — avatar URL updated.'
        : 'Saved — no avatar URL set.',
    );
    await openUserDetail(id);
    await loadUsers();
  } catch (e) {
    showUserMsg(e.message, true);
  }
}

async function resetPassword(id, email) {
  const custom = window.prompt(
    `Reset password for ${email || 'this member'}?\n\nLeave blank to create a temporary password, or type a new one (min 6 characters).`,
    '',
  );
  if (custom === null) return;
  showUserMsg('');
  try {
    const body = custom.trim() ? { password: custom.trim() } : {};
    const data = await api(`/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const temp = data.temporaryPassword || custom.trim();
    window.alert(
      `Password reset for ${data.email || email}.\n\nTemporary password:\n${temp}\n\nCopy it now — sessions for this user were signed out.`,
    );
    showUserMsg('Password reset. Temporary password shown in the alert.');
  } catch (e) {
    showUserMsg(e.message, true);
  }
}

async function deleteUser(id, name) {
  const ok = window.confirm(
    `Delete user "${name}" (#${id})?\n\nThis removes their account, related invites/tables, and cannot be undone.`,
  );
  if (!ok) return;
  showUserMsg('');
  try {
    await api(`/admin/users/${id}`, { method: 'DELETE' });
    resetUserDetail();
    await loadUsers();
  } catch (e) {
    showUserMsg(e.message, true);
    alert(e.message);
  }
}

if (token) {
  showDashboard();
}
