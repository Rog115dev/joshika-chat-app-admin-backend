const API = window.location.origin;
const TOKEN_KEY = 'joshikai_admin_token';

let token = localStorage.getItem(TOKEN_KEY) || '';
let selectedStatus = 'pending';
let selectedId = null;
let selectedUserId = null;
let activeTab = 'verifications';
let counts = { pending: 0, approved: 0, rejected: 0, members: 0 };

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
const toastHost = document.getElementById('toast-host');
const modalHost = document.getElementById('modal-host');

function isMobileLayout() {
  return window.matchMedia('(max-width: 980px)').matches;
}

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

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function selfieSrc(row) {
  return normalizeImageUrl(row.selfieUrl || row.profileImageUrl || '');
}

/** Prefer proxied URL so hotlink-blocked images still show in admin. */
function displayAvatarUrl(raw) {
  const src = normalizeImageUrl(raw);
  if (!src) return '';
  if (src.startsWith('data:image')) return src;
  if (src.includes('/media/selfie/')) return src;
  if (!/^https?:\/\//i.test(src)) return '';
  return `${API}/media/image?u=${encodeURIComponent(src)}`;
}

function toast(message, type = 'ok') {
  if (!toastHost) {
    window.alert(message);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s ease';
    setTimeout(() => el.remove(), 220);
  }, 2800);
}

function closeModal() {
  if (!modalHost) return;
  modalHost.hidden = true;
  modalHost.innerHTML = '';
}

function openModal({ title, bodyHtml, confirmLabel, danger = false, onConfirm }) {
  if (!modalHost) return Promise.resolve(false);
  return new Promise((resolve) => {
    modalHost.hidden = false;
    modalHost.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>${escapeHtml(title)}</h2>
        <div class="muted">${bodyHtml}</div>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" id="modal-cancel">キャンセル</button>
          <button type="button" class="${danger ? 'btn-danger-solid' : 'btn-ok'}" id="modal-ok">
            ${escapeHtml(confirmLabel || 'OK')}
          </button>
        </div>
      </div>
    `;
    const finish = (ok) => {
      closeModal();
      resolve(ok);
      if (ok && onConfirm) onConfirm();
    };
    document.getElementById('modal-cancel').onclick = () => finish(false);
    document.getElementById('modal-ok').onclick = () => finish(true);
    modalHost.onclick = (e) => {
      if (e.target === modalHost) finish(false);
    };
  });
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

function wireAvatarPreview(input) {
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
          ? '直リンクの画像 URL を入力してください（.jpg / .png / Unsplash など）'
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
            '画像を読み込めませんでした。共有ページではなく画像の直 URL を使ってください。';
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

function updateStatsUi() {
  const pendingEl = document.getElementById('stat-pending');
  const membersEl = document.getElementById('stat-members');
  const pill = document.getElementById('pending-pill');
  if (pendingEl) pendingEl.textContent = String(counts.pending);
  if (membersEl) membersEl.textContent = String(counts.members);
  if (pill) {
    if (counts.pending > 0) {
      pill.hidden = false;
      pill.textContent = String(counts.pending);
    } else {
      pill.hidden = true;
    }
  }
  const map = {
    pending: document.getElementById('count-pending'),
    approved: document.getElementById('count-approved'),
    rejected: document.getElementById('count-rejected'),
  };
  for (const [key, el] of Object.entries(map)) {
    if (!el) continue;
    const n = counts[key];
    el.textContent = typeof n === 'number' ? `(${n})` : '';
  }
}

async function refreshCounts() {
  try {
    const [pending, approved, rejected, members] = await Promise.all([
      api('/id-verifications?status=pending&limit=200'),
      api('/id-verifications?status=approved&limit=200'),
      api('/id-verifications?status=rejected&limit=200'),
      api('/admin/users'),
    ]);
    counts = {
      pending: Array.isArray(pending) ? pending.length : 0,
      approved: Array.isArray(approved) ? approved.length : 0,
      rejected: Array.isArray(rejected) ? rejected.length : 0,
      members: Array.isArray(members) ? members.length : 0,
    };
    updateStatsUi();
  } catch (e) {
    console.warn('stats refresh failed', e);
  }
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
  try {
    setTab(activeTab || 'verifications');
    refreshCounts();
  } catch (err) {
    console.error('Dashboard tab error', err);
    if (detailEl) {
      detailEl.innerHTML = `<div class="detail-inner"><p class="error">Dashboard loaded, but the queue failed: ${escapeHtml(err.message || err)}</p></div>`;
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
  }
  if (loginView) {
    loginView.classList.remove('view-hidden');
    loginView.removeAttribute('hidden');
    loginView.style.setProperty('display', 'grid', 'important');
  }
  const btn = document.getElementById('admin-login-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'ログイン / Sign in';
  }
}

function statusBadge(status) {
  const s = String(status || 'pending').toLowerCase();
  const label =
    s === 'approved' ? '承認済' : s === 'rejected' ? '却下' : '未対応';
  const cls =
    s === 'approved'
      ? 'badge-approved'
      : s === 'rejected'
        ? 'badge-rejected'
        : 'badge-pending';
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function syncMobilePanes() {
  const mobile = isMobileLayout();
  const verOpen = activeTab === 'verifications' && selectedId != null;
  const userOpen = activeTab === 'users' && selectedUserId != null;

  if (verificationsListView) {
    verificationsListView.classList.toggle(
      'collapsed-mobile',
      mobile && verOpen,
    );
  }
  if (detailEl) {
    detailEl.classList.toggle('collapsed-mobile', mobile && !verOpen && activeTab === 'verifications');
  }
  if (usersListView) {
    usersListView.classList.toggle('collapsed-mobile', mobile && userOpen);
  }
  if (userDetailEl) {
    userDetailEl.classList.toggle(
      'collapsed-mobile',
      mobile && !userOpen && activeTab === 'users',
    );
  }
  if (backBtn) {
    backBtn.hidden = !(mobile && (verOpen || userOpen));
  }
}

function showListMode() {
  if (activeTab === 'users') {
    selectedUserId = null;
    renderUserEmpty();
  } else {
    selectedId = null;
    renderVerificationEmpty();
  }
  document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  syncMobilePanes();
  if (dashSubtitle) {
    dashSubtitle.textContent =
      activeTab === 'users'
        ? 'アカウントの検索・編集・パスワードリセット'
        : '提出された本人確認を確認・承認します';
  }
}

function renderVerificationEmpty() {
  if (!detailEl) return;
  detailEl.innerHTML = `
    <div class="empty-panel">
      <div class="empty-icon">✓</div>
      <h2>提出を選択</h2>
      <p class="muted">左のリストから本人確認を選ぶと、セルフィーとプロフィールを確認できます。</p>
    </div>
  `;
}

function renderUserEmpty() {
  if (!userDetailEl) return;
  userDetailEl.innerHTML = `
    <div class="empty-panel">
      <div class="empty-icon">◎</div>
      <h2>メンバーを選択</h2>
      <p class="muted">左からメンバーを選ぶと、プロフィール編集やパスワードリセットができます。</p>
    </div>
  `;
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
    dashTitle.textContent = '本人確認';
    loadList();
  } else {
    dashTitle.textContent = 'メンバー';
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
      loginError.textContent = 'メールとパスワードを入力してください。';
      loginError.hidden = false;
    }
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'ログイン中…';
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
    toast('ログインしました');
  } catch (e) {
    if (loginView?.classList.contains('view-hidden')) {
      showLogin(false);
    }
    const msg =
      e.message === 'Failed to fetch'
        ? 'サーバーに接続できません。起動中か確認してください。'
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
      btn.textContent = 'ログイン / Sign in';
    }
  }
}

document.getElementById('admin-login-form')?.addEventListener('submit', doAdminLogin);
document.getElementById('admin-login-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  doAdminLogin(e);
});

document.getElementById('logout-btn')?.addEventListener('click', () => {
  showLogin(true);
  toast('ログアウトしました');
});

backBtn?.addEventListener('click', () => {
  showListMode();
  if (activeTab === 'users') loadUsers();
  else loadList();
});

document.getElementById('refresh-btn')?.addEventListener('click', async () => {
  await refreshCounts();
  if (activeTab === 'users') {
    if (selectedUserId != null) openUserDetail(selectedUserId);
    else loadUsers();
  } else if (selectedId != null) {
    openDetail(selectedId);
  } else {
    loadList();
  }
  toast('最新の状態に更新しました');
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedStatus = btn.dataset.status;
    showListMode();
    loadList();
  });
});

document.getElementById('user-search-btn')?.addEventListener('click', () => loadUsers());
document.getElementById('user-search')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUsers();
});

window.addEventListener('resize', () => syncMobilePanes());

async function loadList() {
  listEl.innerHTML = '<p class="muted list-empty">読み込み中…</p>';
  try {
    const rows = await api(
      `/id-verifications?status=${encodeURIComponent(selectedStatus)}&limit=50`,
    );
    if (!rows.length) {
      listEl.innerHTML = `
        <div class="list-empty">
          <p class="empty-title">該当なし</p>
          <p class="muted tiny">このフィルターに提出はありません。</p>
        </div>`;
      return;
    }
    listEl.innerHTML = '';
    rows.forEach((row) => {
      const card = document.createElement('div');
      card.className = 'card' + (selectedId === row.id ? ' selected' : '');
      card.dataset.id = String(row.id);
      appendAvatar(card, row);
      fillCardBody(
        card,
        displayName(row),
        [
          row.email || 'メールなし',
          row.phoneNumber || '電話なし',
          formatWhen(row.submittedAt),
        ],
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

function markSelectedCard(listRoot, id) {
  listRoot?.querySelectorAll('.card').forEach((c) => {
    c.classList.toggle('selected', String(c.dataset.id) === String(id));
  });
}

async function openDetail(id) {
  selectedId = id;
  markSelectedCard(listEl, id);
  syncMobilePanes();
  detailEl.innerHTML = '<div class="detail-inner"><p class="muted">読み込み中…</p></div>';
  if (dashSubtitle) dashSubtitle.textContent = 'セルフィーとプロフィールを確認してください';
  try {
    const row = await api(`/id-verifications/${id}`);
    const interests = Array.isArray(row.interests) ? row.interests.join(', ') : '';
    const photo = selfieSrc(row);
    const photoUrl = displayAvatarUrl(photo);
    const name = displayName(row);
    const canDecide = String(row.status).toLowerCase() === 'pending';

    detailEl.innerHTML = `
      <div class="detail-inner">
        <div class="detail-hero">
          ${
            displayAvatarUrl(avatarSrc(row))
              ? `<img class="selfie" src="${escapeHtml(displayAvatarUrl(avatarSrc(row)))}" alt="Avatar" referrerpolicy="no-referrer" />`
              : `<div class="detail-avatar-fallback">${escapeHtml((name[0] || '?').toUpperCase())}</div>`
          }
          <div class="copy">
            <h2>${escapeHtml(name)}</h2>
            <p class="muted">提出 #${row.id} · ${escapeHtml(formatWhen(row.submittedAt))}</p>
            <div class="card-foot" style="margin-top:8px">${statusBadge(row.status)}</div>
          </div>
        </div>

        ${
          canDecide
            ? `<div class="review-hint">セルフィーが本人と一致するか確認し、「承認」または「却下」を選んでください。</div>`
            : ''
        }

        <div class="selfie-stage">
          <div>
            <div class="selfie-frame">
              ${
                photoUrl
                  ? `<img src="${escapeHtml(photoUrl)}" alt="Selfie" referrerpolicy="no-referrer" />`
                  : `<div class="no-photo">セルフィー画像がありません</div>`
              }
            </div>
            <p class="selfie-caption">提出セルフィー / Submitted selfie</p>
          </div>
          <div class="detail-section" style="margin:0">
            <h3>プロフィール</h3>
            <dl>
              <dt>メール</dt><dd>${escapeHtml(row.email || '—')}</dd>
              <dt>ニックネーム</dt><dd>${escapeHtml(row.nickname || '—')}</dd>
              <dt>氏名</dt><dd>${escapeHtml(row.name || '—')}</dd>
              <dt>電話</dt><dd>${escapeHtml(row.phoneNumber || '—')}</dd>
              <dt>ステータス</dt><dd>${escapeHtml(row.lifeStatus || '—')}</dd>
              <dt>年齢</dt><dd>${escapeHtml(row.age || '—')}</dd>
              <dt>居住地</dt><dd>${escapeHtml(row.placeOfLiving || '—')}</dd>
              <dt>興味</dt><dd>${escapeHtml(interests || '—')}</dd>
            </dl>
          </div>
        </div>

        <div class="detail-section">
          <h3>管理者メモ</h3>
          <label>メモ（任意）
            <textarea id="admin-note" placeholder="例: セルフィー鮮明、承認">${escapeHtml(row.adminNote || '')}</textarea>
          </label>
        </div>

        <div class="actions">
          <button type="button" id="approve-btn" class="btn-ok" ${canDecide ? '' : 'disabled'}>承認する</button>
          <button type="button" id="reject-btn" class="btn-danger-solid" ${canDecide ? '' : 'disabled'}>却下する</button>
          ${
            row.userId
              ? `<button type="button" id="goto-user-btn" class="btn-ghost">メンバーを開く</button>`
              : ''
          }
        </div>
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
    detailEl.innerHTML = `<div class="detail-inner"><p class="error">${escapeHtml(e.message)}</p></div>`;
  }
}

async function patchStatus(status) {
  const note = document.getElementById('admin-note')?.value || '';
  const label = status === 'approved' ? '承認' : '却下';
  const ok = await openModal({
    title: `${label}の確認`,
    bodyHtml: `<p>この提出を<strong>${escapeHtml(label)}</strong>しますか？</p>`,
    confirmLabel: label === '承認' ? '承認する' : '却下する',
    danger: status === 'rejected',
  });
  if (!ok) return;

  const approveBtn = document.getElementById('approve-btn');
  const rejectBtn = document.getElementById('reject-btn');
  if (approveBtn) approveBtn.disabled = true;
  if (rejectBtn) rejectBtn.disabled = true;

  try {
    await api(`/id-verifications/${selectedId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, adminNote: note }),
    });
    toast(status === 'approved' ? '承認しました' : '却下しました');
    await refreshCounts();
    selectedId = null;
    showListMode();
    await loadList();
  } catch (e) {
    toast(e.message, 'err');
    if (approveBtn) approveBtn.disabled = false;
    if (rejectBtn) rejectBtn.disabled = false;
  }
}

async function loadUsers() {
  usersListEl.innerHTML = '<p class="muted list-empty">メンバーを読み込み中…</p>';
  try {
    const q = document.getElementById('user-search')?.value?.trim() || '';
    const path = q
      ? `/admin/users?q=${encodeURIComponent(q)}`
      : '/admin/users';
    const rows = await api(path);
    if (!q) {
      counts.members = rows.length;
      updateStatsUi();
    }
    if (!rows.length) {
      usersListEl.innerHTML = `
        <div class="list-empty">
          <p class="empty-title">メンバーが見つかりません</p>
          <p class="muted tiny">検索条件を変えてみてください。</p>
        </div>`;
      return;
    }
    usersListEl.innerHTML = '';
    rows.forEach((user) => {
      const card = document.createElement('div');
      card.className = 'card' + (selectedUserId === user.id ? ' selected' : '');
      card.dataset.id = String(user.id);
      appendAvatar(card, user);
      const placeAge = [user.placeOfLiving, user.age ? `${user.age}歳` : '']
        .filter(Boolean)
        .join(' · ');
      fillCardBody(
        card,
        displayName(user),
        [user.email || 'メールなし', placeAge || '居住地未設定'],
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
  markSelectedCard(usersListEl, id);
  syncMobilePanes();
  userDetailEl.innerHTML = '<div class="detail-inner"><p class="muted">読み込み中…</p></div>';
  if (dashSubtitle) dashSubtitle.textContent = 'プロフィールの編集・パスワード管理';
  try {
    const data = await api(`/admin/users/${id}`);
    const user = data.user || data;
    const interests = Array.isArray(user.interests) ? user.interests.join(', ') : '';
    const status = user.verificationStatus || 'pending';
    const img = avatarSrc(user);
    const displayImg = displayAvatarUrl(img);
    const name = displayName(user);
    userDetailEl.innerHTML = `
      <div class="detail-inner">
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
          <h3>プロフィール編集</h3>
          <div class="form-grid">
            <label class="full">アバター URL
              <input id="u-avatar" type="text" value="${escapeHtml(user.profileImageUrl || '')}" placeholder="https://…" />
              <span id="u-avatar-hint" class="field-hint error" hidden></span>
            </label>
            <label>メール<input id="u-email" type="email" value="${escapeHtml(user.email || '')}" /></label>
            <label>ニックネーム<input id="u-nickname" value="${escapeHtml(user.nickname || '')}" /></label>
            <label>氏名<input id="u-name" value="${escapeHtml(user.name || '')}" /></label>
            <label>電話<input id="u-phone" value="${escapeHtml(user.phoneNumber || '')}" /></label>
            <label>年齢<input id="u-age" type="number" min="0" value="${escapeHtml(user.age || 0)}" /></label>
            <label>ライフステータス
              <select id="u-life">
                <option value="student" ${user.lifeStatus === 'student' ? 'selected' : ''}>student</option>
                <option value="working" ${user.lifeStatus === 'working' ? 'selected' : ''}>working</option>
                <option value="other" ${!['student', 'working'].includes(user.lifeStatus) ? 'selected' : ''}>other</option>
              </select>
            </label>
            <label class="full">居住地<input id="u-place" value="${escapeHtml(user.placeOfLiving || '')}" /></label>
            <label class="full">興味（カンマ区切り）<input id="u-interests" value="${escapeHtml(interests)}" /></label>
            <label class="full">自己紹介<textarea id="u-bio" placeholder="短い紹介文">${escapeHtml(user.bio || '')}</textarea></label>
            <label>本人確認ステータス
              <select id="u-status">
                <option value="pending" ${status === 'pending' ? 'selected' : ''}>pending（未対応）</option>
                <option value="approved" ${status === 'approved' ? 'selected' : ''}>approved（承認）</option>
                <option value="rejected" ${status === 'rejected' ? 'selected' : ''}>rejected（却下）</option>
              </select>
            </label>
          </div>
        </div>
        <p id="user-msg" class="success" hidden></p>
        <p id="user-err" class="error" hidden></p>
        <div class="actions">
          <button type="button" id="save-user-btn" class="btn-primary">変更を保存</button>
          <button type="button" id="reset-pw-btn" class="btn-soft">パスワード再設定</button>
          <button type="button" id="delete-user-btn" class="danger">メンバー削除</button>
        </div>
      </div>
    `;
    document.getElementById('save-user-btn').onclick = () => saveUser(user.id);
    document.getElementById('reset-pw-btn').onclick = () => resetPassword(user.id, user.email);
    document.getElementById('delete-user-btn').onclick = () => deleteUser(user.id, displayName(user));
    const avatarInput = document.getElementById('u-avatar');
    if (avatarInput) wireAvatarPreview(avatarInput);
  } catch (e) {
    userDetailEl.innerHTML = `<div class="detail-inner"><p class="error">${escapeHtml(e.message)}</p></div>`;
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
  const btn = document.getElementById('save-user-btn');
  if (btn) btn.disabled = true;
  try {
    const avatarUrl = normalizeImageUrl(
      document.getElementById('u-avatar').value,
    );
    await api(`/admin/users/${id}`, {
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
    toast('保存しました');
    showUserMsg('変更を保存しました。');
    await openUserDetail(id);
    await loadUsers();
    await refreshCounts();
  } catch (e) {
    showUserMsg(e.message, true);
    toast(e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resetPassword(id, email) {
  const custom = window.prompt(
    `${email || 'このメンバー'} のパスワードを再設定します。\n\n空欄のまま OK で一時パスワードを自動生成、または新しいパスワードを入力（6文字以上）:`,
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
    await openModal({
      title: 'パスワードを再設定しました',
      bodyHtml: `
        <p>${escapeHtml(data.email || email)} の一時パスワード:</p>
        <div class="temp-pw-box" id="temp-pw-value">${escapeHtml(temp)}</div>
        <p class="tiny muted">今すぐコピーしてください。このユーザーのセッションは無効化されています。</p>
      `,
      confirmLabel: 'コピーして閉じる',
    }).then(async (ok) => {
      if (ok && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(temp);
          toast('一時パスワードをコピーしました');
        } catch (_) {
          toast('コピーに失敗しました。画面の値を手動でコピーしてください', 'err');
        }
      }
    });
    showUserMsg('パスワードを再設定しました。');
  } catch (e) {
    showUserMsg(e.message, true);
    toast(e.message, 'err');
  }
}

async function deleteUser(id, name) {
  const ok = await openModal({
    title: 'メンバーを削除',
    bodyHtml: `<p><strong>${escapeHtml(name)}</strong>（#${id}）を削除しますか？<br/>関連する招待・テーブルも削除され、元に戻せません。</p>`,
    confirmLabel: '削除する',
    danger: true,
  });
  if (!ok) return;
  showUserMsg('');
  try {
    await api(`/admin/users/${id}`, { method: 'DELETE' });
    toast('メンバーを削除しました');
    showListMode();
    await loadUsers();
    await refreshCounts();
  } catch (e) {
    showUserMsg(e.message, true);
    toast(e.message, 'err');
  }
}

if (token) {
  showDashboard();
}
