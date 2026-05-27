/**
 * Telegram Sender Pro — фронтенд
 * Папка: web/  |  API: тот же origin (/api/...)
 */
const API = window.location.origin;

const state = {
  page: 'dashboard',
  accounts: [],
  campaigns: [],
  recipients: [],
  config: {},
  selectedCampaignId: null,
  pollTimer: null,
  authPhone: '',
};

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) {
    const msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
    throw new Error(msg || r.statusText);
  }
  return data;
}

const $ = (sel, root = document) => root.querySelector(sel);
const app = (html) => { $('#app').innerHTML = html; };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function toast(title, body = '', type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<p class="toast-title">${esc(title)}</p>${body ? `<p class="toast-body">${esc(body)}</p>` : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
  if (type === 'success' && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

async function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function setNav() {
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('nav-active', b.dataset.page === state.page);
  });
}

function openModal(title, bodyHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
}

function setLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
  btn.textContent = loading ? '…' : btn.dataset.originalText;
}

async function loadData() {
  const [accounts, campaigns, rec, config] = await Promise.all([
    api('/api/accounts'),
    api('/api/campaigns'),
    api('/api/recipients'),
    api('/api/config'),
  ]);
  state.accounts = accounts;
  state.campaigns = campaigns;
  state.recipients = rec.recipients || [];
  state.config = config;
}

async function refreshApiStatus() {
  const el = $('#api-status');
  try {
    const h = await api('/api/health');
    el.textContent = h.api_id_set ? 'API: подключено' : 'API: укажите API_ID в .env';
    el.className = 'api-status ok';
  } catch {
    el.textContent = 'API: запустите ./run-web.sh';
    el.className = 'api-status err';
  }
}

async function actionAddAccount(e) {
  const form = e.target.closest('form');
  const phone = form.phone.value.trim();
  const tier = parseInt(form.tier.value, 10) || 2;
  if (!phone) return toast('Укажите телефон', '', 'warning');
  await api('/api/accounts', { method: 'POST', body: JSON.stringify({ phone, tier, notes: 'web' }) });
  toast('Аккаунт добавлен', phone, 'success');
  closeModal();
  state.page = 'accounts';
  await render();
}

async function actionSendCode(e) {
  const btn = e.target;
  setLoading(btn, true);
  try {
    const res = await api('/api/accounts/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ phone: state.authPhone }),
    });
    if (res.status === 'already_authorized') {
      toast('Уже авторизован', res.username || state.authPhone, 'success');
      closeModal();
      await render();
      return;
    }
    if (res.status === 'flood_wait') {
      toast('FloodWait', `${res.seconds} сек`, 'error');
      return;
    }
    toast('Код отправлен', 'Проверьте Telegram', 'success');
  } finally {
    setLoading(btn, false);
  }
}

async function actionConfirmAuth(e) {
  const form = e.target.closest('form');
  const code = form.code.value.trim();
  const password = form.password.value.trim() || null;
  const btn = form.querySelector('button[type=submit]');
  setLoading(btn, true);
  try {
    const res = await api('/api/accounts/auth/confirm', {
      method: 'POST',
      body: JSON.stringify({ phone: state.authPhone, code, password }),
    });
    if (res.status === 'need_password') {
      toast('Нужен пароль 2FA', '', 'warning');
      return;
    }
    if (res.status !== 'ok' && res.status !== 'already_authorized') {
      toast('Ошибка входа', res.message || res.status, 'error');
      return;
    }
    toast('Вход выполнен', res.first_name || state.authPhone, 'success');
    closeModal();
    await render();
  } finally {
    setLoading(btn, false);
  }
}

async function actionStartCampaign(e) {
  const btn = e.target;
  setLoading(btn, true);
  try {
    const name = $('#camp-name').value.trim();
    const message = $('#camp-msg').value.trim();
    const text = $('#camp-recipients').value.trim();
    const recipients = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const min_delay = parseInt($('#min-delay').value, 10) || 3;
    const max_delay = parseInt($('#max-delay').value, 10) || 8;
    const account_phones = [...document.querySelectorAll('input[name=acc]:checked')].map((el) => el.value);

    if (!message) { toast('Введите текст', '', 'warning'); return; }
    if (!recipients.length) { toast('Добавьте получателей', '', 'warning'); return; }
    if (!account_phones.length) { toast('Выберите аккаунты', '', 'warning'); return; }

    const camp = await api('/api/campaigns/start', {
      method: 'POST',
      body: JSON.stringify({ name, message, recipients, account_phones, min_delay, max_delay }),
    });

    toast('Рассылка запущена', camp.name, 'success');
    state.selectedCampaignId = camp.id;
    state.page = 'campaigns';
    startPolling();
    await render();
  } catch (err) {
    toast('Не удалось запустить', err.message, 'error');
  } finally {
    setLoading(btn, false);
  }
}

async function actionSaveRecipients(e) {
  const btn = e.target;
  setLoading(btn, true);
  try {
    const text = $('#recipients-editor').value.trim();
    const recipients = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const res = await api('/api/recipients', { method: 'PUT', body: JSON.stringify({ recipients }) });
    state.recipients = res.recipients;
    toast('Сохранено', `${res.recipients.length} получателей`, 'success');
  } finally {
    setLoading(btn, false);
  }
}

function statCard(label, value, sub = '') {
  return `<div class="card card-p"><p class="text-xs muted">${label}</p><p style="font-size:1.5rem;font-weight:700;margin:0.25rem 0 0">${esc(value)}</p>${sub ? `<p class="text-xs muted mt-2">${esc(sub)}</p>` : ''}</div>`;
}

async function pageDashboard() {
  const d = await api('/api/dashboard');
  const activeCamp = state.campaigns.find((c) => c.status === 'active');
  app(`
    <div class="page">
      <h2>Дашборд</h2>
      <div class="grid-4 mb-4">
        ${statCard('Аккаунты', `${d.accountsActive}/${d.accountsTotal}`, 'с сессией')}
        ${statCard('Получатели', d.recipientsCount)}
        ${statCard('Рассылки', d.campaignsTotal)}
        ${statCard('В процессе', d.campaignsActive)}
      </div>
      ${activeCamp ? `
        <div class="card card-p mb-4">
          <p class="text-sm">Идёт рассылка: <strong>${esc(activeCamp.name)}</strong></p>
          <div class="progress mt-2"><div class="progress-bar" style="width:${activeCamp.progress || 0}%"></div></div>
          <button data-action="view-campaign" data-id="${activeCamp.id}" class="btn btn-ghost text-xs mt-2">Смотреть лог →</button>
        </div>` : ''}
      <div class="flex gap-2">
        <button data-go="create" class="btn btn-primary">Новая рассылка</button>
        <button data-go="accounts" class="btn btn-ghost">Аккаунты</button>
        <button data-action="notify-perm" class="btn btn-ghost">Уведомления</button>
      </div>
    </div>`);
}

async function pageAccounts() {
  await loadData();
  const rows = state.accounts.map((a) => `
    <tr>
      <td class="font-mono">${esc(a.phone)}</td>
      <td><span class="badge ${a.status === 'active' ? 'badge-active' : 'badge-wait'}">${a.status}</span></td>
      <td>${a.sessionActive ? '<span class="text-green">●</span>' : '○'}</td>
      <td>T${a.tier}</td>
      <td style="text-align:right">
        ${!a.sessionActive ? `<button data-action="auth" data-phone="${esc(a.phone)}" class="btn btn-primary text-xs">Войти</button> ` : ''}
        <button data-action="health" data-phone="${esc(a.phone)}" class="btn btn-ghost text-xs">Check</button>
        <button data-action="toggle" data-phone="${esc(a.phone)}" data-active="${a.status !== 'paused'}" class="btn btn-ghost text-xs">${a.status === 'paused' ? 'Вкл' : 'Пауза'}</button>
        <button data-action="delete-acc" data-phone="${esc(a.phone)}" class="btn btn-ghost text-xs text-red">✕</button>
      </td>
    </tr>`).join('');

  app(`
    <div class="page">
      <div class="flex-between mb-4">
        <h2>Аккаунты</h2>
        <div class="flex gap-2">
          <button data-action="add-account-modal" class="btn btn-primary">+ Добавить</button>
          <button data-action="health-all" class="btn btn-ghost">Проверить все</button>
        </div>
      </div>
      <div class="card overflow-auto">
        <table>
          <thead><tr><th>Телефон</th><th>Статус</th><th>Сессия</th><th>Tier</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="muted" style="padding:1.5rem;text-align:center">Нет аккаунтов</td></tr>'}</tbody>
        </table>
      </div>
    </div>`);
}

async function pageRecipients() {
  await loadData();
  app(`
    <div class="page">
      <h2>Получатели</h2>
      <p class="text-sm muted mb-4">@username или ID — по одному на строку → data/recipients.txt</p>
      <div class="card card-p">
        <textarea id="recipients-editor" class="font-mono" style="height:16rem" placeholder="@user1">${state.recipients.map(esc).join('\n')}</textarea>
        <button data-action="save-recipients" class="btn btn-primary mt-3">Сохранить</button>
      </div>
    </div>`);
}

async function pageCampaigns() {
  await loadData();
  if (state.selectedCampaignId) {
    let c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
    if (!c) c = await api(`/api/campaigns/${state.selectedCampaignId}`);
    if (c) return pageCampaignDetail(c);
  }

  const rows = state.campaigns.map((c) => `
    <div class="card campaign-card" data-action="view-campaign" data-id="${c.id}">
      <div class="flex-between">
        <div>
          <h3 style="margin:0;font-size:1rem">${esc(c.name)}</h3>
          <p class="text-xs muted mt-2">${c.status} · ${c.recipientsDelivered || 0}/${c.recipientsTotal} · ${c.progress || 0}%</p>
        </div>
        <span class="badge ${c.status === 'active' ? 'badge-wait' : 'badge-active'}">${c.status}</span>
      </div>
    </div>`).join('');

  app(`
    <div class="page">
      <div class="flex-between mb-4">
        <h2>Рассылки</h2>
        <button data-go="create" class="btn btn-primary">+ Создать</button>
      </div>
      ${rows || '<p class="muted">Нет рассылок</p>'}
    </div>`);
}

function pageCampaignDetail(c) {
  const logs = (c.logs || []).slice().reverse().map((l) => `
    <div class="text-xs log-${l.type}" style="padding:0.35rem 0;border-bottom:1px solid #232d3d40">
      <span class="muted">${l.timestamp}</span> ${esc(l.message)}
      ${l.account ? `<span class="muted"> (${esc(l.account)})</span>` : ''}
    </div>`).join('');

  app(`
    <div class="page">
      <button data-action="back-campaigns" class="btn btn-ghost text-sm mb-4">← Назад</button>
      <h2>${esc(c.name)}</h2>
      <p class="text-sm muted">${c.status} · ${c.recipientsDelivered || 0} OK · ${c.recipientsFailed || 0} ошибок</p>
      <div class="progress mt-3"><div class="progress-bar" style="width:${c.progress || 0}%"></div></div>
      <div class="card card-p mt-4 max-h-96 overflow-auto">${logs || '<p class="muted text-sm">Лог пуст</p>'}</div>
    </div>`);
}

async function pageCreate() {
  await loadData();
  const ready = state.accounts.filter((a) => a.sessionActive);
  const accChecks = ready.map((a) => `
    <label class="text-sm" style="display:flex;gap:0.5rem;align-items:center;padding:0.25rem 0">
      <input type="checkbox" name="acc" value="${esc(a.phone)}" checked /> ${esc(a.phone)}
    </label>`).join('');

  app(`
    <div class="page">
      <h2>Новая рассылка</h2>
      <div class="card card-p mb-4 space-y-3">
        <div><label>Название</label><input id="camp-name" value="Рассылка ${new Date().toLocaleDateString('ru')}" /></div>
        <div><label>Сообщение (спинтакс: {Привет|Здравствуйте})</label><textarea id="camp-msg" style="height:9rem" placeholder="Текст…"></textarea></div>
      </div>
      <div class="card card-p mb-4">
        <label>Получатели</label>
        <textarea id="camp-recipients" class="font-mono mt-2" style="height:8rem">${state.recipients.map(esc).join('\n')}</textarea>
        <div class="flex gap-2 mt-2" style="align-items:center">
          <input id="min-delay" type="number" class="w-20" value="${state.config.campaignMinDelay || 3}" min="1" />
          <span class="muted">—</span>
          <input id="max-delay" type="number" class="w-20" value="${state.config.campaignMaxDelay || 8}" min="1" />
          <span class="text-xs muted">сек между сообщениями</span>
        </div>
      </div>
      <div class="card card-p mb-4">
        <p class="text-xs muted mb-2">Аккаунты</p>
        ${accChecks || '<p class="text-yellow text-sm">Нет сессий → Аккаунты → Войти</p>'}
      </div>
      <button data-action="start-campaign" class="btn btn-primary" style="padding:0.75rem 2rem;font-size:1rem" ${!ready.length ? 'disabled' : ''}>Запустить рассылку</button>
    </div>`);
}

async function pageSettings() {
  const cfg = await api('/api/config');
  app(`
    <div class="page">
      <h2>Настройки</h2>
      <div class="card card-p text-sm space-y-2">
        <p><span class="muted">Спинтакс:</span> ${cfg.enableSpintax ? 'вкл' : 'выкл'}</p>
        <p><span class="muted">Задержка:</span> ${cfg.campaignMinDelay}–${cfg.campaignMaxDelay} сек</p>
        <p class="text-xs muted mt-3">API_ID и API_HASH — файл .env в корне проекта</p>
        <p class="text-xs muted">Консоль: python3 main.py</p>
      </div>
    </div>`);
}

async function render() {
  setNav();
  try {
    if (state.page !== 'campaigns' || !state.selectedCampaignId) await loadData();
    if (state.page === 'dashboard') await pageDashboard();
    else if (state.page === 'accounts') await pageAccounts();
    else if (state.page === 'recipients') await pageRecipients();
    else if (state.page === 'campaigns') await pageCampaigns();
    else if (state.page === 'create') await pageCreate();
    else if (state.page === 'settings') await pageSettings();
  } catch (e) {
    app(`<div class="page"><p class="text-red">Ошибка: ${esc(e.message)}</p>
      <p class="text-sm muted mt-2">В терминале:</p>
      <code class="card card-p text-xs" style="display:block;margin-top:0.5rem">./run-web.sh</code></div>`);
  }
}

function go(page) {
  state.page = page;
  if (page !== 'campaigns') state.selectedCampaignId = null;
  render();
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.campaigns.some((c) => c.status === 'active') && !state.selectedCampaignId) return;
    try {
      const prev = state.campaigns.find((c) => c.id === state.selectedCampaignId);
      await loadData();
      const cur = state.campaigns.find((c) => c.id === state.selectedCampaignId);
      if (state.selectedCampaignId && cur && prev && cur.progress !== prev.progress) {
        const last = (cur.logs || []).slice(-1)[0];
        if (last?.type === 'success') toast('Доставлено', last.message, 'success');
      }
      if (['campaigns', 'dashboard'].includes(state.page)) await render();
    } catch (_) {}
  }, 2000);
}

document.body.addEventListener('click', async (e) => {
  const goBtn = e.target.closest('[data-go]');
  if (goBtn) { go(goBtn.dataset.go); return; }

  const el = e.target.closest('[data-action]');
  if (!el) return;

  const { action, phone, id } = el.dataset;

  try {
    if (action === 'add-account-modal') {
      openModal('Новый аккаунт', `
        <form id="form-add-acc" class="space-y-3">
          <input name="phone" placeholder="+79991234567" required />
          <input name="tier" type="number" value="2" min="1" max="3" />
          <button type="submit" class="btn btn-primary" style="width:100%">Добавить</button>
        </form>`);
      $('#form-add-acc').onsubmit = (ev) => { ev.preventDefault(); actionAddAccount(ev); };
    } else if (action === 'auth') {
      state.authPhone = phone;
      openModal('Вход в Telegram', `
        <p class="text-sm muted mb-3">${esc(phone)}</p>
        <button data-action="send-code" class="btn btn-primary" style="width:100%;margin-bottom:0.75rem">Отправить код</button>
        <form id="form-auth" class="space-y-2">
          <input name="code" placeholder="Код из Telegram" required />
          <input name="password" type="password" placeholder="2FA пароль" />
          <button type="submit" class="btn btn-primary" style="width:100%">Подтвердить</button>
        </form>`);
      $('#form-auth').onsubmit = (ev) => { ev.preventDefault(); actionConfirmAuth(ev); };
    } else if (action === 'send-code') await actionSendCode(e);
    else if (action === 'health-all') {
      await api('/api/accounts/health-check', { method: 'POST' });
      toast('Проверка завершена', '', 'success');
      await render();
    } else if (action === 'health') {
      await api(`/api/accounts/${encodeURIComponent(phone)}/health-check`, { method: 'POST' });
      toast('OK', phone, 'success');
      await render();
    } else if (action === 'toggle') {
      await api(`/api/accounts/${encodeURIComponent(phone)}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: el.dataset.active !== 'true' }),
      });
      await render();
    } else if (action === 'delete-acc') {
      if (!confirm(`Удалить ${phone}?`)) return;
      await api(`/api/accounts/${encodeURIComponent(phone)}`, { method: 'DELETE' });
      toast('Удалён', phone, 'info');
      await render();
    } else if (action === 'start-campaign') await actionStartCampaign(e);
    else if (action === 'save-recipients') await actionSaveRecipients(e);
    else if (action === 'view-campaign') {
      state.selectedCampaignId = id;
      state.page = 'campaigns';
      startPolling();
      await render();
    } else if (action === 'back-campaigns') {
      state.selectedCampaignId = null;
      await render();
    } else if (action === 'notify-perm') {
      await requestNotifyPermission();
      toast('Уведомления', Notification.permission, 'info');
    }
  } catch (err) {
    toast('Ошибка', err.message, 'error');
  }
});

$('#modal-close').onclick = closeModal;
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

refreshApiStatus();
requestNotifyPermission();
loadData().then(() => { render(); startPolling(); });
setInterval(refreshApiStatus, 15000);
