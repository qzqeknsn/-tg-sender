var API_BASE = window.location.origin;

// Редирект на логин если зашли снаружи (не после успешного входа)
(function() {
  if (window.location.pathname === '/' || window.location.pathname === '') {
    var loggedIn = sessionStorage.getItem('logged_in');
    if (!loggedIn) {
      window.location.href = '/login';
    } else {
      sessionStorage.removeItem('logged_in');
    }
  }
})();

async function apiFetch(path, opts) {
  opts = opts || {};
  var token = localStorage.getItem('tg_sender_token');
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.headers) {
    for (var k in opts.headers) headers[k] = opts.headers[k];
  }
  var res = await fetch(API_BASE + path, {
    headers: headers,
    ...opts,
  });
  if (res.status === 401) {
    localStorage.removeItem('tg_sender_token');
    localStorage.removeItem('tg_sender_user');
    window.location.href = '/login';
    return;
  }
  if (!res.ok) {
    var data = {};
    try { data = await res.json(); } catch (_) {}
    throw new Error(data.detail || res.statusText);
  }
  return res.json();
}

// Load current user into localStorage on page load
(async function() {
  var token = localStorage.getItem('tg_sender_token');
  if (token) {
    try { var u = await apiFetch('/api/auth/me'); localStorage.setItem('tg_sender_user', JSON.stringify(u)); } catch(e) {}
  }
})();

window.api = {
  getStats: function () { return apiFetch('/api/stats'); },
  getCampaigns: function () { return apiFetch('/api/campaigns'); },
  getChart: function () { return apiFetch('/api/chart/delivery'); },
  getAccounts: function () { return apiFetch('/api/accounts'); },
  getLogs: function (campaignId) { return apiFetch('/api/logs?campaign_id=' + encodeURIComponent(campaignId) + '&limit=50'); },
  stopCampaign: function (id) { return apiFetch('/api/campaigns/' + encodeURIComponent(id) + '/stop', { method: 'POST' }); },
  getRecipients: function () { return apiFetch('/api/recipients'); },
  saveRecipients: function (recipients) { return apiFetch('/api/recipients', { method: 'PUT', body: JSON.stringify({ recipients: recipients }) }); },
  addAccount: function (phone, tier, notes) { return apiFetch('/api/accounts', { method: 'POST', body: JSON.stringify({ phone: phone, tier: tier || 2, notes: notes || '' }) }); },
  deleteAccount: function (phone) { return apiFetch('/api/accounts/' + encodeURIComponent(phone), { method: 'DELETE' }); },
  deleteSession: function (phone) { return apiFetch('/api/accounts/' + encodeURIComponent(phone) + '/session', { method: 'DELETE' }); },
  updateAccount: function (phone, updates) { return apiFetch('/api/accounts/' + encodeURIComponent(phone), { method: 'PATCH', body: JSON.stringify(updates) }); },
  startCampaign: function (data) { return apiFetch('/api/campaigns/start', { method: 'POST', body: JSON.stringify(data) }); },
  createCampaign: function (data) { return apiFetch('/api/campaigns/create', { method: 'POST', body: JSON.stringify(data) }); },
  deleteCampaign: function (id) { return apiFetch('/api/campaigns/' + encodeURIComponent(id), { method: 'DELETE' }); },
  health: function () { return apiFetch('/api/health'); },
  healthAll: function () { return apiFetch('/api/accounts/health-check', { method: 'POST' }); },
  healthOne: function (phone) { return apiFetch('/api/accounts/' + encodeURIComponent(phone) + '/health-check', { method: 'POST' }); },
  getConfig: function () { return apiFetch('/api/config'); },
  authSendCode: function (phone) { return apiFetch('/api/accounts/auth/send-code', { method: 'POST', body: JSON.stringify({ phone: phone }) }); },
  authConfirm: function (phone, code, password) { return apiFetch('/api/accounts/auth/confirm', { method: 'POST', body: JSON.stringify({ phone: phone, code: code, password: password || null }) }); },
  getUsers: function() { return apiFetch('/api/users'); },
  addUser: function(phone, role, name) { return apiFetch('/api/users', { method: 'POST', body: JSON.stringify({ phone: phone, tier: 2, notes: name || role || '' }) }); },
  deleteUser: function(phone) { return apiFetch('/api/users/' + encodeURIComponent(phone), { method: 'DELETE' }); },
  getMe: function() { return apiFetch('/api/auth/me'); },
  logout: function() {
    localStorage.removeItem('tg_sender_token');
    localStorage.removeItem('tg_sender_user');
    window.location.href = '/login';
  },
};

(function () {
  var POLL_INTERVAL = 10000;
  var pollTimer = null;
  var _prevState = { campaigns: [], stats: {} };

  function mapAccount(a) {
    var idx = arguments[1];
    return {
      id: a.phone || 'acc-' + (idx != null ? idx : Math.random().toString(36).slice(2)),
      phone: a.phone,
      tier: a.tier || 2,
      active: a.status !== 'paused',
      sessionActive: a.sessionActive || false,
      proxy: a.proxy || null,
      notes: a.notes || '',
      status: a.status || (a.sessionActive ? 'active' : 'waiting'),
      limitToday: a.limitToday || 0,
      limitMax: a.limitMax || 50,
      lastError: a.lastError || '',
    };
  }

  function mapCampaign(c) {
    var logs = c.logs || [];
    var sent = logs.filter(function(l){ return l.type === 'success' || l.type === 'error'; }).length;
    var delivered = logs.filter(function(l){ return l.type === 'success'; }).length;
    var total = c.recipients ? c.recipients.length : (c.recipientsTotal || Math.max(sent, delivered) || 0);
    return {
      id: c.id || c.name || 'camp-' + Math.random().toString(36).slice(2),
      name: c.name || 'Без названия',
      status: c.status || 'pending',
      progress: c.progress || (total > 0 ? Math.round((sent / total) * 100) : 0),
      recipientsTotal: total,
      recipientsSent: sent,
      recipientsDelivered: delivered,
      recipientsFailed: c.recipientsFailed || 0,
      createdAt: c.createdAt || '',
      completedAt: c.completedAt || null,
      message: c.message || '',
      logs: logs,
      accounts: c.accounts || [],
      minDelay: c.minDelay || 3,
      maxDelay: c.maxDelay || 8,
    };
  }

  function mapPieData(campaigns) {
    var sent = 0, delivered = 0, failed = 0;
    (campaigns || []).forEach(function(c) {
      sent += c.recipientsSent || 0;
      delivered += c.recipientsDelivered || 0;
      failed += c.recipientsFailed || 0;
    });
    var read = Math.round(delivered * 0.25);
    var pending = Math.max(0, sent - delivered - failed);
    return [
      { name: "Доставлено", value: delivered, color: "#10b981" },
      { name: "Прочитано", value: read, color: "#3b82f6" },
      { name: "Ошибки", value: failed, color: "#ef4444" },
      { name: "В ожидании", value: pending, color: "#f59e0b" },
    ];
  }

  function mapStats(s) {
    return {
      accountsTotal: s.accounts_count || 0,
      sentToday: s.sent_today || 0,
      sentTodayDelta: s.sent_today_delta_pct || 0,
      activeCampaigns: s.active_campaigns_count || 0,
      totalDelivered: s.total_delivered || 0,
      totalFailed: s.total_failed || 0,
    };
  }

  function mapChartData(item) {
    var hour = item.hour;
    if (hour !== undefined) {
      var h = String(hour);
      if (h.length === 1) h = '0' + h;
      return { time: h + ':00', sent: item.sent || 0, delivered: item.delivered || 0 };
    }
    return { time: item.time || '', sent: item.sent || 0, delivered: item.delivered || 0 };
  }

  function aggregateDailyFromHourly(hourlyData) {
    // Aggregate hourly data into daily buckets
    var days = {};
    (hourlyData || []).forEach(function(item) {
      var time = item.time || '';
      var day = 'today'; // API only returns today's hourly data
      if (!days[day]) days[day] = { day: day, sent: 0, delivered: 0 };
      days[day].sent += item.sent || 0;
      days[day].delivered += item.delivered || 0;
    });
    return Object.keys(days).map(function(k) { return days[k]; });
  }

  function checkAndNotify(store, newCampaigns, newStats) {
    var addN = window.store.getState().addNotification;
    if (!addN) return;

    // 1. Рассылка завершилась
    (_prevState.campaigns || []).forEach(function(prev) {
      var curr = newCampaigns.find(function(c) { return c.id === prev.id; });
      if (!curr) return;

      if (prev.status === 'active' && curr.status !== 'active') {
        var delivered = curr.logs
          ? curr.logs.filter(function(l){ return l.type === 'success'; }).length
          : curr.delivered || 0;
        var failed = curr.logs
          ? curr.logs.filter(function(l){ return l.type === 'error'; }).length
          : 0;
        var total = delivered + failed;

        if (curr.status === 'stopped') {
          addN({
            type: 'warning',
            title: 'Рассылка остановлена',
            message: '\u00AB' + curr.name + '\u00BB остановлена. Отправлено: ' + delivered + ' из ' + total,
          });
        } else {
          addN({
            type: 'success',
            title: 'Рассылка завершена \u2713',
            message: '\u00AB' + curr.name + '\u00BB \u2014 успешно: ' + delivered + ', ошибок: ' + failed + ', всего: ' + total,
          });
        }
      }

      // Прогресс достиг 25%, 50%, 75%
      var milestones = [25, 50, 75];
      if (curr.status === 'active' && curr.progress && prev.progress) {
        milestones.forEach(function(m) {
          if (prev.progress < m && curr.progress >= m) {
            addN({
              type: 'info',
              title: 'Прогресс рассылки',
              message: '\u00AB' + curr.name + '\u00BB \u2014 выполнено ' + m + '% (' + (curr.sent || curr.delivered || 0) + ' сообщений)',
            });
          }
        });
      }

      // Появились ошибки (новые)
      var prevErrors = (prev.logs || []).filter(function(l){ return l.type === 'error'; }).length;
      var currErrors = (curr.logs || []).filter(function(l){ return l.type === 'error'; }).length;
      if (currErrors > prevErrors && currErrors - prevErrors >= 5) {
        addN({
          type: 'error',
          title: 'Ошибки при отправке',
          message: '\u00AB' + curr.name + '\u00BB \u2014 ' + (currErrors - prevErrors) + ' новых ошибок (UserNotFound, FloodWait и др.)',
        });
      }
    });

    // 2. Новая рассылка запущена
    newCampaigns.forEach(function(curr) {
      var existed = (_prevState.campaigns || []).find(function(p){ return p.id === curr.id; });
      if (!existed && curr.status === 'active') {
        addN({
          type: 'info',
          title: 'Рассылка запущена',
          message: '\u00AB' + curr.name + '\u00BB \u2014 ' + (curr.total || '?') + ' получателей',
        });
      }
    });

    // 3. Аккаунт отвалился
    if (_prevState.accounts && _prevState.accounts.length > 0) {
      var newAccounts = window.store.getState().accounts || [];
      (_prevState.accounts || []).forEach(function(prev) {
        var curr = newAccounts.find(function(a){ return a.phone === prev.phone; });
        if (curr && prev.sessionActive && !curr.sessionActive) {
          addN({
            type: 'error',
            title: 'Аккаунт недоступен',
            message: prev.phone + ' \u2014 сессия оборвалась. Требуется повторная авторизация.',
          });
        }
      });
    }

    // Сохраняем состояние для следующей проверки
    _prevState = {
      campaigns: JSON.parse(JSON.stringify(newCampaigns || [])),
      stats: JSON.parse(JSON.stringify(newStats || {})),
      accounts: JSON.parse(JSON.stringify(window.store.getState().accounts || [])),
    };
  }

  var _syncingFromApi = false;

  function refreshData(store) {
    return Promise.all([
      window.api.getStats(),
      window.api.getCampaigns(),
      window.api.getAccounts(),
      window.api.getChart(),
    ]).then(function(results) {
      var stats = results[0];
      var campaigns = results[1];
      var accounts = results[2];
      var chart = results[3];
      var mappedCamps = (campaigns || []).map(mapCampaign);
      var mappedChart = (chart || []).map(mapChartData);
      var dailyChart = mappedChart.map(function(d) {
        return { day: d.time, sent: d.sent, delivered: d.delivered };
      });
      _syncingFromApi = true;
      store.setState({
        stats: mapStats(stats),
        campaigns: mappedCamps,
        accounts: (accounts || []).map(mapAccount),
        chart: mappedChart,
        dailyChart: dailyChart,
        pieChart: mapPieData(mappedCamps),
      });
      _syncingFromApi = false;
      checkAndNotify(store, mappedCamps, mapStats(stats || {}));
      console.log('API data loaded:', { stats: stats, campaigns: campaigns.length, accounts: accounts.length });
    }).catch(function(err) {
      _syncingFromApi = false;
      console.error('API refresh error:', err);
    });
  }

  function startPolling(store) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function() { refreshData(store); }, POLL_INTERVAL);
  }

  function waitForStore() {
    var token = localStorage.getItem('tg_sender_token');
    if (!token) { window.location.href = '/login'; return; }
    if (!window.store || !window.store.setState) {
      setTimeout(waitForStore, 100);
      return;
    }
    console.log('React Bridge: store found, connecting to API...');
    var store = window.store;

    // Загружаем данные сразу
    refreshData(store).then(function() {
      startPolling(store);
    });
  }

  // Запуск
  setTimeout(waitForStore, 200);

  // --- Перехват модалки "Добавить аккаунт" ---
  var _authPhone = null;
  var _authProxy = null;
  var _authInProgress = false;
  var _modalWired = false;

  var _wiredModals = [];

  function wireModal() {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var btn = all[i];
      if (btn._aw) continue;
      var text = (btn.textContent || '').trim();
      if (text !== 'Подключить') continue;

      // Проверяем — кнопка видна на экране и находится внутри оверлея
      if (!btn.offsetParent) continue;
      var rect = btn.getBoundingClientRect();
      if (rect.width === 0) continue;

      // Проверяем, что внутри модалки (над ней есть backdrop)
      var el = btn.parentElement;
      var found = false;
      while (el && el !== document.body) {
        var cls = el.className || '';
        if (typeof cls === 'string' && cls.indexOf('fixed') >= 0 && cls.indexOf('inset-0') >= 0) {
          found = true;
          break;
        }
        el = el.parentElement;
      }
      if (!found) continue;

      btn._aw = true;
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleModalSubmit(btn);
      }, true);
    }
  }

  function normalizePhone(raw) {
    var digits = raw.replace(/\D/g, '');
    if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
      return '+7' + digits.substring(1);
    }
    if (digits.length === 10) {
      return '+7' + digits;
    }
    return digits.length >= 7 ? '+' + digits : raw;
  }

  function findPhone(el) {
    var inputs = document.querySelectorAll('input[placeholder*="999"], input[placeholder*="+7"], input[type="tel"]');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].offsetParent) {
        var v = inputs[i].value.trim();
        if (v.replace(/\D/g,'').length >= 7) return normalizePhone(v);
      }
    }
    var all = document.querySelectorAll('input');
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetParent) {
        var v = all[i].value.trim();
        if (v.replace(/\D/g,'').length >= 7) return normalizePhone(v);
      }
    }
    return null;
  }

  function handleModalSubmit(btn) {
    var phone = findPhone(btn);
    if (!phone) {
      var s = window.store && window.store.getState();
      if (s) s.addNotification({message: 'Введите номер телефона', type: 'error'});
      return;
    }
    var proxy = '';
    var all = document.querySelectorAll('input');
    for (var i = 0; i < all.length; i++) {
      if (!all[i].offsetParent) continue;
      var v = all[i].value.trim();
      if (v.indexOf('http://') === 0 || v.indexOf('https://') === 0 || v.indexOf('socks') === 0) {
        proxy = v;
        break;
      }
    }
    startAuth(phone, proxy);
  }

  // --- Ввод кода (5 квадратиков) ---

  function setupCodeBoxes() {
    var boxes = document.querySelectorAll('.code-digit');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i]._handler = function(e) {
        var box = e.target;
        var val = box.value.replace(/\D/g, '');
        box.value = val.slice(0, 1);
        var idx = parseInt(box.getAttribute('data-idx'));
        if (val && idx < 4) {
          document.querySelector('.code-digit[data-idx="' + (idx + 1) + '"]').focus();
        }
        // Auto-submit when all 5 filled
        var full = '';
        var allBoxes = document.querySelectorAll('.code-digit');
        for (var j = 0; j < allBoxes.length; j++) {
          full += allBoxes[j].value;
        }
        if (full.length === 5) {
          window._submitCode();
        }
      };
      boxes[i].addEventListener('input', boxes[i]._handler);
      boxes[i].addEventListener('keydown', function(e) {
        if (e.key === 'Backspace') {
          var box = e.target;
          var idx = parseInt(box.getAttribute('data-idx'));
          if (!box.value && idx > 0) {
            document.querySelector('.code-digit[data-idx="' + (idx - 1) + '"]').focus();
          }
        }
      });
    }
  }

  function getCodeFromBoxes() {
    var code = '';
    var boxes = document.querySelectorAll('.code-digit');
    for (var i = 0; i < boxes.length; i++) {
      code += boxes[i].value || '';
    }
    return code;
  }

  function clearCodeBoxes() {
    var boxes = document.querySelectorAll('.code-digit');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].value = '';
    }
    document.querySelector('.code-digit[data-idx="0"]').focus();
  }

  function shakeCodeBoxes() {
    var container = document.getElementById('codeBoxes');
    container.style.animation = 'none';
    void container.offsetHeight; // reflow
    container.style.animation = 'codeShake .4s ease';
  }

  function showCodeSuccess() {
    var boxes = document.getElementById('codeBoxes');
    var success = document.getElementById('codeSuccess');
    var resend = document.getElementById('resendBtn');
    var submit = document.getElementById('codeSubmitBtn');
    boxes.style.display = 'none';
    success.style.display = 'block';
    resend.style.display = 'none';
    submit.style.display = 'none';
    setTimeout(function() {
      document.getElementById('codeDialog').close();
      // Если указан прокси — сохраняем после создания аккаунта
      if (_authProxy) {
        window.api.updateAccount(_authPhone, { proxy: _authProxy }).catch(function(){});
      }
      refreshData(window.store);
      _authPhone = null;
      _authProxy = null;
    }, 1200);
  }

  function resetCodeDialog() {
    var boxes = document.getElementById('codeBoxes');
    var success = document.getElementById('codeSuccess');
    var error = document.getElementById('codeError');
    var resend = document.getElementById('resendBtn');
    var submit = document.getElementById('codeSubmitBtn');
    var passInput = document.getElementById('passInput');
    boxes.style.display = 'flex';
    success.style.display = 'none';
    error.style.display = 'none';
    resend.style.display = '';
    submit.style.display = 'none';
    passInput.style.display = 'none';
    passInput.value = '';
    clearCodeBoxes();
  }

  // Inject shake keyframes
  (function() {
    if (!document.getElementById('_codeShakeStyle')) {
      var s = document.createElement('style');
      s.id = '_codeShakeStyle';
      s.textContent = '@keyframes codeShake { 0%,100% { transform: translateX(0) } 20% { transform: translateX(-8px) } 40% { transform: translateX(8px) } 60% { transform: translateX(-6px) } 80% { transform: translateX(6px) } }';
      document.head.appendChild(s);
    }
  })();

  async function startAuth(phone, proxy) {
    if (_authInProgress) return;
    _authInProgress = true;
    try {
      _authPhone = phone;
      _authProxy = proxy;
      var result = await window.api.authSendCode(phone);

      if (result.status === 'already_authorized') {
        refreshData(window.store);
        var s = window.store.getState();
        s.addNotification({message: 'Этот аккаунт уже авторизован в Telegram', type: 'warning'});
        return;
      }
      if (result.status === 'flood_wait') {
        var mins = Math.ceil(result.seconds / 60);
        var s = window.store.getState();
        s.addNotification({message: 'Telegram блокирует отправку. Подождите ' + mins + ' мин', type: 'warning'});
        return;
      }
      if (result.status === 'error') {
        var s = window.store.getState();
        s.addNotification({message: 'Ошибка: ' + (result.message || 'не удалось отправить код'), type: 'error'});
        return;
      }

      resetCodeDialog();
      document.getElementById('codeDialogTitle').textContent = 'Подтверждение: ' + phone;
      var codeType = result.type || '';
      if (codeType.indexOf('App') >= 0) {
        document.getElementById('codeDialogDesc').textContent = 'Код пришёл в приложение Telegram. Открой Telegram на телефоне → сообщение от Telegram';
      } else if (codeType.indexOf('Sms') >= 0) {
        document.getElementById('codeDialogDesc').textContent = 'Код отправлен SMS на номер';
      } else if (result.reused) {
        document.getElementById('codeDialogDesc').textContent = 'Код уже отправлен. Проверьте Telegram или SMS';
      } else {
        document.getElementById('codeDialogDesc').textContent = 'Код отправлен. Проверьте приложение Telegram';
      }
      setupCodeBoxes();
      document.getElementById('codeDialog').showModal();
      setTimeout(function() {
        document.querySelector('.code-digit[data-idx="0"]').focus();
      }, 100);
    } catch (err) {
      var s = window.store && window.store.getState();
      if (s) s.addNotification({message: 'Ошибка: ' + (err.message || 'не удалось начать авторизацию'), type: 'error'});
    } finally {
      _authInProgress = false;
    }
  }

  window._submitCode = async function() {
    var code = getCodeFromBoxes();
    if (code.length < 5) return;

    var password = document.getElementById('passInput').value.trim();
    var errEl = document.getElementById('codeError');
    var boxes = document.getElementById('codeBoxes');

    errEl.style.display = 'none';
    boxes.style.pointerEvents = 'none';
    boxes.style.opacity = '0.6';

    try {
      var result = await window.api.authConfirm(_authPhone, code, password || null);
      if (result.status === 'ok') {
        showCodeSuccess();
        return;
      }
      if (result.status === 'need_password') {
        document.getElementById('passInput').style.display = 'block';
        document.getElementById('codeDialogDesc').textContent = 'Требуется пароль двухфакторной аутентификации';
        document.querySelector('.code-digit[data-idx="0"]').focus();
        boxes.style.pointerEvents = '';
        boxes.style.opacity = '';
        return;
      }
      if (result.status === 'invalid_code') {
        shakeCodeBoxes();
        errEl.textContent = 'Неверный код. Попробуйте снова';
        errEl.style.display = 'block';
        clearCodeBoxes();
      } else if (result.status === 'error') {
        shakeCodeBoxes();
        errEl.textContent = result.message || 'Ошибка подтверждения';
        errEl.style.display = 'block';
        clearCodeBoxes();
      }
    } catch (err) {
      shakeCodeBoxes();
      errEl.textContent = err.message || 'Ошибка соединения';
      errEl.style.display = 'block';
      clearCodeBoxes();
    }
    boxes.style.pointerEvents = '';
    boxes.style.opacity = '';
  };

  window._resendCode = function() {
    var btn = document.getElementById('resendBtn');
    btn.disabled = true;
    btn.textContent = 'Отправка...';
    btn.style.opacity = '0.5';

    doResendCode()
      .then(function(result) {
        if (result.status === 'code_sent') {
          var desc = document.getElementById('codeDialogDesc');
          var origDesc = desc.textContent;
          desc.textContent = 'Код отправлен!';
          desc.style.color = '#22c55e';
          setTimeout(function() {
            desc.textContent = origDesc;
            desc.style.color = '';
          }, 2000);
          // 30 сек таймер
          var wait = 30;
          btn.textContent = 'Повторная отправка через ' + wait + 'с';
          btn.style.opacity = '0.5';
          var timer = setInterval(function() {
            wait--;
            if (wait <= 0) {
              clearInterval(timer);
              btn.textContent = 'Отправить код ещё раз';
              btn.style.opacity = '';
              btn.disabled = false;
            } else {
              btn.textContent = 'Повторная отправка через ' + wait + 'с';
            }
          }, 1000);
        } else if (result.status === 'flood_wait') {
          var secs = result.seconds || 60;
          btn.textContent = 'Подождите ' + Math.ceil(secs / 60) + ' мин';
          setTimeout(function() {
            btn.textContent = 'Отправить код ещё раз';
            btn.style.opacity = '';
            btn.disabled = false;
          }, Math.min(secs * 1000, 120000));
        } else {
          btn.textContent = 'Ошибка, попробуйте ещё';
          setTimeout(function() {
            btn.textContent = 'Отправить код ещё раз';
            btn.style.opacity = '';
            btn.disabled = false;
          }, 3000);
        }
      })
      .catch(function() {
        btn.textContent = 'Отправить код ещё раз';
        btn.style.opacity = '';
        btn.disabled = false;
      });
  };

  async function doResendCode() {
    try {
      await window.api.deleteSession(_authPhone);
    } catch(_) {}
    try {
      await apiFetch('/api/accounts/auth/' + encodeURIComponent(_authPhone), { method: 'DELETE' });
    } catch(_) {}
    return await window.api.authSendCode(_authPhone);
  }

  window._closeCodeDialog = function() {
    document.getElementById('codeDialog').close();
    _authPhone = null;
    _authProxy = null;
  };

  // --- Campaign list action handlers ---

  window.api.restartCampaign = function(id) {
    return apiFetch('/api/campaigns/' + encodeURIComponent(id) + '/restart', { method: 'POST' });
  };

  window.api.downloadCampaign = function(id) {
    var token = localStorage.getItem('tg_sender_token');
    var baseUrl = '/api/campaigns/' + encodeURIComponent(id) + '/download?format=csv';
    var url = token ? baseUrl + '&token=' + encodeURIComponent(token) : baseUrl;
    var a = document.createElement('a');
    a.href = url;
    a.download = 'campaign_' + id + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Direct click handlers for campaign card buttons: Пауза / Старт / Повтор / Удалить / Скачать
  function getCampaignNameFromChild(el) {
    while (el) {
      if (el.className && typeof el.className === 'string' && el.className.indexOf('rounded-xl') >= 0 && el.className.indexOf('p-5') >= 0) break;
      el = el.parentElement;
    }
    if (!el) return null;
    var h3s = el.querySelectorAll('h3');
    for (var i = 0; i < h3s.length; i++) {
      var h = h3s[i];
      if (h.className && typeof h.className === 'string' && h.className.indexOf('truncate') >= 0) {
        return h.textContent.trim();
      }
    }
    return null;
  }

  function findCampaignIdByName(name) {
    var camps = window.store && window.store.getState().campaigns || [];
    for (var i = 0; i < camps.length; i++) {
      if (camps[i].name === name) return camps[i].id;
    }
    return null;
  }

  function wireCampaignCardButtons() {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var btn = all[i];
      if (btn._ccw) continue;

      // Must be inside an actions row (border-t border-[#232d3d])
      var parent = btn.parentElement;
      if (!parent) continue;
      var pclass = parent.className || '';
      if (typeof pclass !== 'string' || pclass.indexOf('border-t') < 0 || pclass.indexOf('border-[') < 0) continue;

      var text = (btn.textContent || '').trim();

      if (text === 'Пауза' || text === 'Старт' || text === 'Повтор') {
        btn._ccw = true;
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          var btnText = (this.textContent || '').trim();
          var name = getCampaignNameFromChild(this);
          if (!name) return;
          var id = findCampaignIdByName(name);
          if (!id) return;
          var state = window.store.getState();

          if (btnText === 'Пауза') {
            window.api.stopCampaign(id).then(function() {
              state.updateCampaign(id, { status: 'paused' });
              state.addNotification({message: 'Рассылка "' + name + '" поставлена на паузу', type: 'warning'});
            }).catch(function(err) {
              state.addNotification({message: 'Ошибка паузы: ' + name, type: 'error'});
            });
          } else if (btnText === 'Старт' || btnText === 'Повтор') {
            window.api.restartCampaign(id).then(function(result) {
              if (result) {
                state.updateCampaign(result.id, result);
                state.addNotification({message: 'Рассылка "' + name + '" запущена', type: 'success'});
              }
            }).catch(function(err) {
              state.addNotification({message: 'Ошибка запуска: ' + name, type: 'error'});
            });
          }
        }, true);
      } else {
        // Icon buttons (download / delete) — no text
        // Identify by class: download has hover:text-white hover:bg-[#232d3d], delete has hover:text-red-400
        var cls = btn.className || '';
        if (typeof cls !== 'string') continue;

        if (cls.indexOf('hover:text-red-400') >= 0) {
          // Delete button
          btn._ccw = true;
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            e.stopImmediatePropagation();
            var name = getCampaignNameFromChild(this);
            if (!name) return;
            var id = findCampaignIdByName(name);
            if (!id) return;
            var state = window.store.getState();

            if (!confirm('Удалить рассылку "' + name + '"?')) return;
            window.api.deleteCampaign(id).then(function() {
              state.removeCampaign(id);
              state.addNotification({message: 'Рассылка "' + name + '" удалена', type: 'success'});
            }).catch(function(err) {
              state.addNotification({message: 'Ошибка удаления: ' + name, type: 'error'});
            });
          }, true);
        } else if (cls.indexOf('hover:text-white') >= 0 && cls.indexOf('hover:bg-[#232d3d]') >= 0) {
          // Download button
          btn._ccw = true;
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            e.stopImmediatePropagation();
            var name = getCampaignNameFromChild(this);
            if (!name) return;
            var id = findCampaignIdByName(name);
            if (!id) return;
            window.api.downloadCampaign(id);
          }, true);
        }
      }
    }
  }

  // --- Campaign start (Запустить) interception ---

  async function handleStartCampaign() {
    var store = window.store;
    var state = store.getState();
    var data = state.wizardData;
    var speech = data.speeches && data.speeches[0];

    if (!speech || !speech.content) {
      state.addNotification({message: 'Добавьте текст сообщения в Спич #1', type: 'error'});
      return;
    }
    if (!data.recipients || data.recipients.length === 0) {
      state.addNotification({message: 'Добавьте получателей', type: 'error'});
      return;
    }
    if (!data.selectedAccounts || data.selectedAccounts.length === 0) {
      state.addNotification({message: 'Выберите хотя бы один аккаунт', type: 'error'});
      return;
    }

    try {
      var result = await window.api.startCampaign({
        name: data.name,
        message: speech.content,
        recipients: data.recipients,
        account_phones: data.selectedAccounts,
        min_delay: data.minDelay,
        max_delay: data.maxDelay,
      });

      store.getState().addCampaign(mapCampaign(result));
      store.getState().addNotification({message: 'Рассылка "' + data.name + '" запущена!', type: 'success'});
      store.getState().resetWizard();
      store.getState().setActiveTab('dashboard');
    } catch (err) {
      store.getState().addNotification({message: 'Ошибка: ' + (err.message || 'не удалось запустить'), type: 'error'});
    }
  }

  function wireCampaignButtons() {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var btn = all[i];
      if (btn._csw) continue;
      var text = (btn.textContent || '').trim();
      if (text !== 'Запустить') continue;
      if (!btn.offsetParent) continue;
      if (btn.getBoundingClientRect().width === 0) continue;

      // Check if inside the campaign creation panel
      var el = btn.parentElement;
      var insideWizard = false;
      while (el && el !== document.body) {
        if (el.id === 'root') { insideWizard = true; break; }
        el = el.parentElement;
      }
      if (!insideWizard) continue;

      btn._csw = true;
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleStartCampaign();
      }, true);
    }
  }

  // --- CSV/File upload for recipients ---

  function parseRecipientsFromText(text) {
    var lines = text.split(/\r?\n/);
    var result = [];
    var isFirstLine = true;
    var isHeaderRow = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#') === 0) continue;

      // Check if first line looks like CSV header
      if (isFirstLine) {
        isFirstLine = false;
        var lower = line.toLowerCase();
        if ((lower.indexOf('username') >= 0 || lower.indexOf('phone') >= 0 || lower.indexOf('user') >= 0 || lower.indexOf('tg') >= 0) && line.indexOf(',') >= 0) {
          isHeaderRow = true;
          // Parse header to find username column index
          var headers = parseCsvLine(line);
          var colIdx = 0;
          for (var h = 0; h < headers.length; h++) {
            var hl = headers[h].toLowerCase().replace(/['"]/g, '');
            if (hl.indexOf('username') >= 0 || hl.indexOf('tg') >= 0 || hl.indexOf('telegram') >= 0 || hl.indexOf('user') >= 0 || hl.indexOf('login') >= 0) {
              colIdx = h;
              break;
            }
          }
          continue; // skip header, will use colIdx for data rows
        }
      }

      if (isHeaderRow) {
        // CSV data rows - parse
        var cols = parseCsvLine(line);
        var val = cols[0] || '';
        val = val.replace(/^["']|["']$/g, '').trim();
        if (val) result.push(val);
      } else {
        // Simple text: one recipient per line
        result.push(line);
      }
    }
    return result;
  }

  function parseCsvLine(line) {
    var result = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  function wireCsvUploadButton() {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var btn = all[i];
      if (btn._csvw) continue;
      var text = (btn.textContent || '').trim();
      if (text !== 'Загрузить CSV') continue;
      if (!btn.offsetParent) continue;
      if (btn.getBoundingClientRect().width === 0) continue;

      // Check if inside the wizard panel
      var el = btn.parentElement;
      var insideWizard = false;
      while (el && el !== document.body) {
        if (el.id === 'root') { insideWizard = true; break; }
        el = el.parentElement;
      }
      if (!insideWizard) continue;

      btn._csvw = true;

      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();

        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,.txt';
        input.style.display = 'none';
        document.body.appendChild(input);

        input.addEventListener('change', function(ev) {
          var file = ev.target.files[0];
          if (!file) { document.body.removeChild(input); return; }

          var reader = new FileReader();
          reader.onload = function(re) {
            var textContent = re.target.result;
            var parsed = parseRecipientsFromText(textContent);

            if (parsed.length === 0) {
              var s = window.store && window.store.getState();
              if (s) s.addNotification({message: 'Не найдено получателей в файле', type: 'warning'});
              document.body.removeChild(input);
              return;
            }

            // Merge with existing recipients in wizardData
            var state = window.store && window.store.getState();
            if (!state) { document.body.removeChild(input); return; }
            var existing = (state.wizardData && state.wizardData.recipients) || [];
            var merged = existing.slice();
            parsed.forEach(function(r) {
              if (merged.indexOf(r) < 0) merged.push(r);
            });
            state.updateWizardData({ recipients: merged });
            state.addNotification({message: 'Загружено ' + parsed.length + ' получателей' + (merged.length > existing.length ? ' (добавлено ' + (merged.length - existing.length) + ')' : ''), type: 'success'});
            document.body.removeChild(input);
          };
          reader.readAsText(file);
        });

        input.click();
      }, true);
    }
  }

  // --- Notification bell button ---

  function wireBellButton() {
    var header = document.querySelector('header');
    if (!header) return;
    var btns = header.querySelectorAll('button');
    if (btns.length < 2) return;
    // Bell is the last button in the header (search might be hidden when open)
    var parent = btns[btns.length - 1];
    if (!parent || parent._bellWired) return;
    // Bell has no React onClick; skip buttons inside relative wrapper (search)
    if (parent.parentElement && parent.parentElement.className && parent.parentElement.className.indexOf && parent.parentElement.className.indexOf('relative') >= 0) return;

    parent._bellWired = true;
    var panel = null;
    var backdrop = null;
    var self = this;

    function closePanel() {
      if (backdrop && backdrop.parentNode) backdrop.remove();
      if (panel && panel.parentNode) panel.remove();
      backdrop = null;
      panel = null;
    }

    // Inject keyframes once
    if (!document.getElementById('_notifDrawerStyle')) {
      var st = document.createElement('style');
      st.id = '_notifDrawerStyle';
      st.textContent = '@keyframes drawerSlideIn { from { transform: translateX(100%) } to { transform: translateX(0) } } @keyframes fadeInBg { from { opacity: 0 } to { opacity: 1 } }';
      document.head.appendChild(st);
    }

    // Global close: click outside drawer or Escape
    document.addEventListener('click', function(e) {
      if (_justOpened) { _justOpened = false; return; }
      if (panel && panel.parentNode) {
        var target = e.target;
        // If click target is the backdrop or outside the drawer panel
        if (!panel.contains(target) && !parent.contains(target)) closePanel();
      }
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' && panel && panel.parentNode) closePanel();
    });

    var _justOpened = false;

    parent.addEventListener('click', function() {
      if (panel && panel.parentNode) {
        closePanel();
        return;
      }
      _justOpened = true;
      var s = window.store && window.store.getState();
      var notifs = (s && s.notifications) || [];
      if (notifs.length === 0) {
        s.addNotification({message: 'Новых уведомлений нет', type: 'warning'});
        return;
      }

      // Backdrop
      backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:199;background:rgba(0,0,0,.5);animation:fadeInBg .25s ease';
      document.body.appendChild(backdrop);

      // Drawer panel
      panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;top:64px;right:0;bottom:0;width:380px;z-index:200;background:#151e2a;border-left:1px solid #232d3d;box-shadow:-8px 0 40px rgba(0,0,0,.4);display:flex;flex-direction:column;animation:drawerSlideIn .25s ease';

      // Header
      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #232d3d;flex-shrink:0';
      hdr.innerHTML = '<span style="font-size:14px;font-weight:700;color:#f0f4f8">\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F <span style="font-size:11px;color:#8896ab;font-weight:400;margin-left:4px">' + notifs.length + '</span></span>' +
        '<button id="_notifCloseBtn" style="width:28px;height:28px;border:none;border-radius:6px;background:#232d3d;color:#8896ab;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">&times;</button>';
      panel.appendChild(hdr);
      hdr.querySelector('#_notifCloseBtn').addEventListener('click', closePanel);

      // Scrollable list
      var list = document.createElement('div');
      list.style.cssText = 'flex:1;overflow-y:auto;padding:8px 0';
      notifs.slice().reverse().forEach(function(n) {
        var colors = { success: '#10b981', error: '#ef4444', warning: '#f59e0b' };
        var bgColors = { success: 'rgba(16,185,129,.1)', error: 'rgba(239,68,68,.1)', warning: 'rgba(245,158,11,.1)' };
        var borders = { success: '1px solid rgba(16,185,129,.2)', error: '1px solid rgba(239,68,68,.2)', warning: '1px solid rgba(245,158,11,.2)' };
        var item = document.createElement('div');
        item.style.cssText = 'padding:12px 20px;border-bottom:' + (borders[n.type] || '1px solid #1e252e') + ';font-size:13px;color:#e8edf5;display:flex;align-items:start;gap:10px;cursor:default;transition:background .15s';
        item.innerHTML = '<span style="display:inline-flex;width:8px;height:8px;border-radius:50%;margin-top:5px;flex-shrink:0;background:' + (colors[n.type] || '#8896ab') + '"></span>' +
          '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:12px;color:' + (colors[n.type] || '#8896ab') + ';margin-bottom:2px">' + (n.title || '') + '</div><div style="word-break:break-word;line-height:1.4">' + n.message + '</div></div>';
        item.addEventListener('mouseenter', function() { item.style.background = bgColors[n.type] || '#1e252e'; });
        item.addEventListener('mouseleave', function() { item.style.background = 'transparent'; });
        list.appendChild(item);
      });
      panel.appendChild(list);

      // Clear all button
      var footer = document.createElement('div');
      footer.style.cssText = 'padding:12px 20px;border-top:1px solid #232d3d;flex-shrink:0';
      footer.innerHTML = '<button id="_notifClearBtn" style="width:100%;height:36px;border:1px solid #232d3d;border-radius:8px;background:transparent;color:#8896ab;font-size:12px;cursor:pointer;transition:color .15s,background .15s">\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0432\u0441\u0435</button>';
      footer.querySelector('#_notifClearBtn').addEventListener('click', function() {
        var st = window.store.getState();
        st.notifications.slice().forEach(function(n) { st.removeNotification(n.id); });
        closePanel();
      });
      footer.querySelector('#_notifClearBtn').addEventListener('mouseenter', function() { this.style.background = '#232d3d'; this.style.color = '#f0f4f8'; });
      footer.querySelector('#_notifClearBtn').addEventListener('mouseleave', function() { this.style.background = 'transparent'; this.style.color = '#8896ab'; });
      panel.appendChild(footer);

      document.body.appendChild(panel);
    });
  }

  function wireProfilePopup() {
    var avatarEl = document.querySelector('.w-8.h-8.rounded-full.bg-gradient-to-br');
    if (!avatarEl) return;
    var profileEl = avatarEl.closest('.flex.items-center.gap-2');
    if (!profileEl) return;

    if (profileEl.getAttribute('data-profile-wired')) return;
    profileEl.setAttribute('data-profile-wired', '1');

    profileEl.style.cursor = 'pointer';
    profileEl.style.borderRadius = '8px';
    profileEl.style.padding = '4px 6px';
    profileEl.style.transition = 'background .15s';
    profileEl.addEventListener('mouseenter', function() { profileEl.style.background = 'rgba(255,255,255,.04)'; });
    profileEl.addEventListener('mouseleave', function() { profileEl.style.background = 'transparent'; });

    profileEl.addEventListener('click', function(e) {
      e.stopPropagation();
      showProfilePopup();
    });
  }

  function showProfilePopup() {
    var existing = document.getElementById('_profilePopupOverlay');
    if (existing) { document.body.removeChild(existing); return; }

    var userStr = localStorage.getItem('tg_sender_user');
    var user = userStr ? JSON.parse(userStr) : null;
    var phone = user && user.phone ? user.phone : '—';
    var role = user && user.role ? user.role : '—';

    // Read saved profile name, or default to current DOM display
    var savedName = localStorage.getItem('tg_profile_name') || '';
    var nameSpan = document.querySelector('.text-sm.font-medium.text-white.truncate');
    var displayName = savedName || (nameSpan ? nameSpan.textContent : '');

    var initials = localStorage.getItem('tg_profile_initials') || '';
    if (!initials) {
      initials = (displayName.match(/[A-ZА-Я]/g) || []).slice(0, 2).join('') || displayName.slice(0, 2).toUpperCase();
    }

    // Overlay
    var overlay = document.createElement('div');
    overlay.id = '_profilePopupOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,.5);animation:fadeInBg .2s';
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });

    // Popup card
    var popup = document.createElement('div');
    popup.style.cssText = 'width:340px;max-width:90vw;background:#111b27;border:1px solid #232d3d;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)';

    // Header
    var header = document.createElement('div');
    header.style.cssText = 'padding:20px 24px 16px;border-bottom:1px solid #232d3d;display:flex;align-items:center;justify-content:space-between';
    header.innerHTML = '<span style="font-size:16px;font-weight:600;color:#f0f4f8">\u041F\u0440\u043E\u0444\u0438\u043B\u044C</span>' +
      '<span style="width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;color:#8896ab;transition:background .15s" id="_profileCloseBtn">\u2716</span>';
    popup.appendChild(header);

    // Avatar section
    var avatarSection = document.createElement('div');
    avatarSection.style.cssText = 'padding:20px 24px;display:flex;align-items:center;gap:16px';
    avatarSection.innerHTML =
      '<div id="_profileAvatarDisplay" style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#3b82f6);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;font-weight:700;color:#fff">' + initials + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13px;color:#8896ab;margin-bottom:4px">\u0422\u0435\u043B\u0435\u0444\u043E\u043D</div>' +
        '<div style="font-size:15px;color:#e8edf5;font-weight:500">' + phone + '</div>' +
      '</div>';
    popup.appendChild(avatarSection);

    // Name field
    var fieldSection = document.createElement('div');
    fieldSection.style.cssText = 'padding:0 24px 20px';
    fieldSection.innerHTML =
      '<label style="display:block;font-size:13px;color:#8896ab;margin-bottom:6px">\u041E\u0442\u043E\u0431\u0440\u0430\u0436\u0430\u0435\u043C\u043E\u0435 \u0438\u043C\u044F</label>' +
      '<input id="_profileNameInput" value="' + displayName.replace(/"/g, '&quot;') + '" style="width:100%;height:40px;padding:0 12px;background:#0d1520;border:1px solid #232d3d;border-radius:8px;color:#e8edf5;font-size:14px;outline:none" />';
    popup.appendChild(fieldSection);

    // Role field
    var roleSection = document.createElement('div');
    roleSection.style.cssText = 'padding:0 24px 20px';
    var roleOptions = [
      { value: 'admin', label: '\u0410\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440' },
      { value: 'viewer', label: '\u041D\u0430\u0431\u043B\u044E\u0434\u0430\u0442\u0435\u043B\u044C' },
    ];
    var roleOptsHtml = roleOptions.map(function(o) {
      return '<option value="' + o.value + '"' + (o.value === role ? ' selected' : '') + '>' + o.label + '</option>';
    }).join('');
    roleSection.innerHTML =
      '<label style="display:block;font-size:13px;color:#8896ab;margin-bottom:6px">\u0420\u043E\u043B\u044C</label>' +
      '<select id="_profileRoleSelect" style="width:100%;height:40px;padding:0 12px;background:#0d1520;border:1px solid #232d3d;border-radius:8px;color:#e8edf5;font-size:14px;outline:none;cursor:pointer">' + roleOptsHtml + '</select>';
    popup.appendChild(roleSection);

    // Buttons
    var btnSection = document.createElement('div');
    btnSection.style.cssText = 'padding:0 24px 20px;display:flex;flex-direction:column;gap:8px';
    btnSection.innerHTML =
      '<button id="_profileSaveBtn" style="width:100%;height:40px;border:none;border-radius:8px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff;font-size:14px;font-weight:500;cursor:pointer;transition:opacity .15s">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>' +
      '<button id="_profileLogoutBtn" style="width:100%;height:40px;border:1px solid #ef4444;border-radius:8px;background:transparent;color:#ef4444;font-size:14px;font-weight:500;cursor:pointer;transition:background .15s">\u0412\u044B\u0439\u0442\u0438</button>';
    popup.appendChild(btnSection);

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    // Close
    document.getElementById('_profileCloseBtn').addEventListener('click', function() { document.body.removeChild(overlay); });

    // Save
    document.getElementById('_profileSaveBtn').addEventListener('click', function() {
      var name = document.getElementById('_profileNameInput').value.trim();
      var newRole = document.getElementById('_profileRoleSelect').value;
      if (!name) return;

      var btn = document.getElementById('_profileSaveBtn');
      btn.textContent = '\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435...';
      btn.style.opacity = '.7';
      btn.disabled = true;

      apiFetch('/api/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: name, role: newRole })
      }).then(function(resp) {
        // Save to localStorage
        localStorage.setItem('tg_profile_name', name);
        var init = (name.match(/[A-Za-z\u0410-\u044F]/g) || []).slice(0, 2).join('').toUpperCase() || name.slice(0, 2).toUpperCase();
        localStorage.setItem('tg_profile_initials', init);

        // Update stored user
        if (resp.user) localStorage.setItem('tg_sender_user', JSON.stringify(resp.user));

        // Update DOM — name
        var nameEls = document.querySelectorAll('.text-sm.font-medium.text-white.truncate');
        nameEls.forEach(function(el) { el.textContent = name; });

        // Update DOM — initials
        var initEls = document.querySelectorAll('.w-8.h-8.rounded-full.bg-gradient-to-br .text-xs.font-bold.text-white');
        initEls.forEach(function(el) { if (el.parentElement) el.textContent = init; });

        // Update DOM — role
        var roleLabel = roleOptions.reduce(function(m, o) { return o.value === newRole ? o.label : m; }, '');
        var roleEl = document.querySelector('.flex.items-center.gap-2 .text-xs');
        if (!roleEl) {
          // fallback: find any element with text-xs and truncate
          var roleEls = document.querySelectorAll('[class*=\"text-xs\"][class*=\"truncate\"]');
          roleEls.forEach(function(el) { if (el.textContent.length < 30) el.textContent = roleLabel; });
        } else {
          roleEl.textContent = roleLabel;
        }

        // Update popup avatar
        var av = document.getElementById('_profileAvatarDisplay');
        if (av) av.textContent = init;

        btn.textContent = '\u2713 \u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E';
        btn.style.opacity = '.7';
        setTimeout(function() { btn.textContent = '\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C'; btn.style.opacity = '1'; btn.disabled = false; }, 1500);
      }).catch(function(err) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.textContent = '\u2716 \u041E\u0448\u0438\u0431\u043A\u0430';
        setTimeout(function() { btn.textContent = '\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C'; }, 2000);
      });
    });

    // Logout
    document.getElementById('_profileLogoutBtn').addEventListener('click', function() {
      localStorage.removeItem('tg_sender_token');
      localStorage.removeItem('tg_sender_user');
      window.location.href = '/login';
    });
  }

  // --- SETTINGS PAGE ---

  function wireSettingsPage() {
    // Only run when settings tab is visible
    var settingsEl = document.querySelector('h2');
    if (!settingsEl || settingsEl.textContent !== '\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438') return;

    // Prevent re-wiring
    if (document.getElementById('_settingsWired')) return;

    // Load settings from server once
    apiFetch('/api/settings').then(function(s) {
      localStorage.setItem('tg_settings', JSON.stringify(s));
      applySettingsToDOM(s);
      wireSettingsForm(s);
    }).catch(function() {
      // Try from cache
      var cached = localStorage.getItem('tg_settings');
      if (cached) try { applySettingsToDOM(JSON.parse(cached)); } catch(e) {}
    });

    // Mark wired
    var marker = document.createElement('div');
    marker.id = '_settingsWired';
    marker.style.display = 'none';
    document.body.appendChild(marker);
  }

  function applySettingsToDOM(s) {
    if (!s) return;

    // Language select
    var langSelect = findSelectByLabel('\u042F\u0437\u044B\u043A \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430');
    if (langSelect) langSelect.value = s.language === 'en' ? 'English' : '\u0420\u0443\u0441\u0441\u043A\u0438\u0439';

    // Timezone select
    var tzSelect = findSelectByLabel('\u0427\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u043E\u044F\u0441');
    if (tzSelect) {
      var tzLabel = timezoneLabel(s.timezone);
      for (var i = 0; i < tzSelect.options.length; i++) {
        if (tzSelect.options[i].text === tzLabel) { tzSelect.selectedIndex = i; break; }
      }
    }

    // Speed buttons
    var speedContainer = findSectionByLabel('\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u0430\u044F \u0441\u043A\u043E\u0440\u043E\u0441\u0442\u044C');
    if (speedContainer) {
      var speedBtns = speedContainer.querySelectorAll('button');
      var speedMap = { 'fast': 0, 'medium': 1, 'slow': 2 };
      var idx = speedMap[s.default_speed] || 1;
      for (var i = 0; i < speedBtns.length; i++) {
        setSpeedButtonActive(speedBtns[i], i === idx);
      }
    }

    // Theme
    setTheme(s.theme || 'dark');

    // Apply language
    applyLanguage(s.language || 'ru');
  }

  function wireSettingsForm(s) {
    // Save button
    var allBtns = document.querySelectorAll('button');
    var saveBtn = null;
    for (var i = 0; i < allBtns.length; i++) {
      if (allBtns[i].textContent.trim() === '\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C' && allBtns[i].offsetParent) {
        saveBtn = allBtns[i];
        break;
      }
    }
    if (!saveBtn || saveBtn._settingsWired) return;
    saveBtn._settingsWired = true;

    saveBtn.addEventListener('click', function(e) {
      e.preventDefault();

      var settings = {};

      // Language
      var langSelect = findSelectByLabel('\u042F\u0437\u044B\u043A \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430');
      if (langSelect) settings.language = langSelect.value === 'English' ? 'en' : 'ru';

      // Timezone
      var tzSelect = findSelectByLabel('\u0427\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u043E\u044F\u0441');
      if (tzSelect) settings.timezone = tzSelect.value;

      // Speed
      var speedContainer = findSectionByLabel('\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u0430\u044F \u0441\u043A\u043E\u0440\u043E\u0441\u0442\u044C');
      if (speedContainer) {
        var speedBtns = speedContainer.querySelectorAll('button');
        var speedRevMap = ['fast', 'medium', 'slow'];
        for (var i = 0; i < speedBtns.length; i++) {
          if (speedBtns[i].classList.contains('border-blue-500')) {
            settings.default_speed = speedRevMap[i] || 'medium';
            break;
          }
        }
      }

      // Theme
      settings.theme = localStorage.getItem('tg_theme') || 'dark';

      // FloodWait threshold
      var thresholdInput = document.querySelector('input[type="number"]');
      if (thresholdInput) settings.flood_wait_threshold = parseInt(thresholdInput.value) || 15;

      // Notifications
      var notifContainer = findSectionByLabel('\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F');
      if (notifContainer) {
        var notifRows = notifContainer.querySelectorAll('.flex.items-center.justify-between');
        var notifKeys = ['campaign_completed', 'account_error', 'daily_report', 'flood_wait'];
        settings.notifications = {};
        notifRows.forEach(function(row, idx) {
          var toggleBtn = row.querySelector('button');
          if (toggleBtn && notifKeys[idx]) {
            settings.notifications[notifKeys[idx]] = toggleBtn.classList.contains('bg-blue-500');
          }
        });
      }

      // Webhook URL
      var webhookInput = document.querySelector('input[placeholder*="webhook"]');
      if (webhookInput) settings.webhook_url = webhookInput.value;

      // Save to server
      var btn = saveBtn;
      btn.textContent = '\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435...';
      btn.disabled = true;

      apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings)
      }).then(function(resp) {
        localStorage.setItem('tg_settings', JSON.stringify(resp));
        applySettingsToDOM(resp);

        btn.innerHTML = '\u2713 \u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E';
        btn.className = 'flex items-center gap-2 px-6 py-2.5 text-sm font-medium rounded-lg transition-all active:scale-[0.98] bg-emerald-500 text-white';
        setTimeout(function() {
          btn.innerHTML = '<svg class="w-4 h-4" ...></svg> \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C';
          btn.className = 'flex items-center gap-2 px-6 py-2.5 text-sm font-medium rounded-lg transition-all active:scale-[0.98] bg-blue-500 hover:bg-blue-600 text-white';
          btn.disabled = false;
        }, 2000);
      }).catch(function(err) {
        btn.disabled = false;
        btn.textContent = '\u2716 \u041E\u0448\u0438\u0431\u043A\u0430';
        setTimeout(function() { btn.textContent = '\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C'; }, 2000);
      });
    });
  }

  function findSelectByLabel(labelText) {
    var labels = document.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === labelText) {
        var next = labels[i].nextElementSibling;
        if (next && next.tagName === 'SELECT') return next;
        // Check parent
        var parent = labels[i].parentElement;
        if (parent) {
          var sel = parent.querySelector('select');
          if (sel) return sel;
        }
      }
    }
    return null;
  }

  function findSectionByLabel(labelText) {
    var labels = document.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === labelText) {
        var el = labels[i].parentElement;
        while (el && el !== document.body) {
          var next = el.nextElementSibling;
          if (next) return next;
          el = el.parentElement;
        }
        return labels[i].parentElement;
      }
    }
    return null;
  }

  function setSpeedButtonActive(btn, active) {
    if (active) {
      btn.classList.add('border-blue-500', 'bg-blue-500/10', 'text-blue-400');
      btn.classList.remove('border-[#232d3d]', 'text-[#8896ab]', 'hover:border-[#2e3a4a]');
    } else {
      btn.classList.remove('border-blue-500', 'bg-blue-500/10', 'text-blue-400');
      btn.classList.add('border-[#232d3d]', 'text-[#8896ab]', 'hover:border-[#2e3a4a]');
    }
  }

  function timezoneLabel(tz) {
    var map = { 'Europe/Moscow': 'Moscow (UTC+3)', 'Europe/London': 'London (UTC+0)', 'America/New_York': 'New York (UTC-5)' };
    return map[tz] || tz;
  }

  // --- THEME SWITCHING ---

  var themeStyle = null;

  function initTheme() {
    if (themeStyle) return;
    themeStyle = document.createElement('style');
    themeStyle.id = '_themeStyles';
    themeStyle.textContent = `
      [data-theme="light"] {
        --bg-primary: #f0f4f8 !important;
        --bg-secondary: #ffffff !important;
        --bg-tertiary: #e2e8f0 !important;
        --bg-card: #ffffff !important;
        --bg-input: #ffffff !important;
        --border-color: #cbd5e1 !important;
        --text-primary: #0f172a !important;
        --text-secondary: #475569 !important;
        --text-muted: #64748b !important;
      }
    `;
    document.head.appendChild(themeStyle);

    // Apply saved theme
    var saved = localStorage.getItem('tg_theme') || 'dark';
    setTheme(saved);
  }

  function setTheme(theme) {
    localStorage.setItem('tg_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'light') {
      applyLightTheme();
    } else {
      removeLightTheme();
    }
  }

  function applyLightTheme() {
    var css = document.getElementById('_lightTheme');
    if (css) return;
    var style = document.createElement('style');
    style.id = '_lightTheme';
    style.textContent = getLightThemeCSS();
    document.head.appendChild(style);
  }

  function removeLightTheme() {
    var css = document.getElementById('_lightTheme');
    if (css) css.remove();
  }

  function getLightThemeCSS() {
    return `
      /* Override all dark backgrounds with light ones */
      .bg-\\[\\#0b0e13\\], .bg-\\[\\#111b27\\], .bg-\\[\\#151e2a\\], .bg-\\[\\#0f1419\\], .bg-\\[\\#0d1520\\] {
        background-color: #f8fafc !important;
      }
      .bg-\\[\\#1e252e\\] {
        background-color: #e2e8f0 !important;
      }
      .bg-\\[\\#232d3d\\] {
        background-color: #cbd5e1 !important;
      }
      .border-\\[\\#232d3d\\] {
        border-color: #cbd5e1 !important;
      }
      .text-white, .text-\\[\\#f0f4f8\\], .text-\\[\\#e8edf5\\] {
        color: #0f172a !important;
      }
      .text-\\[\\#8896ab\\] {
        color: #475569 !important;
      }
      .text-\\[\\#8896ab\\].truncate {
        color: #64748b !important;
      }
      .hover\\:bg-\\[\\#232d3d\\]:hover {
        background-color: #cbd5e1 !important;
      }
      .hover\\:bg-\\[\\#1e252e\\]:hover {
        background-color: #e2e8f0 !important;
      }
      .hover\\:text-white:hover {
        color: #0f172a !important;
      }
      .placeholder-\\[\\#8896ab\\]::placeholder {
        color: #94a3b8 !important;
      }
      .bg-\\[\\#0f1419\\] {
        background-color: #ffffff !important;
      }
      input, select, textarea {
        color: #0f172a !important;
        background-color: #ffffff !important;
      }
      select option {
        background-color: #ffffff !important;
        color: #0f172a !important;
      }
      .bg-black\\/60 {
        background-color: rgba(0,0,0,.3) !important;
      }
    `;
  }

  // --- LANGUAGE SWITCHING ---

  var langMap = {
    '\u0414\u0430\u0448\u0431\u043E\u0440\u0434': { en: 'Dashboard' },
    '\u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0438': { en: 'Campaigns' },
    '\u0421\u043E\u0437\u0434\u0430\u0442\u044C': { en: 'Create' },
    '\u0410\u043A\u043A\u0430\u0443\u043D\u0442\u044B': { en: 'Accounts' },
    '\u0410\u043D\u0430\u043B\u0438\u0442\u0438\u043A\u0430': { en: 'Analytics' },
    '\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438': { en: 'Settings' },
    '\u0410\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440': { en: 'Admin' },
    '\u041D\u0430\u0431\u043B\u044E\u0434\u0430\u0442\u0435\u043B\u044C': { en: 'Viewer' },
    '\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C': { en: 'Save' },
    '\u041E\u0442\u043C\u0435\u043D\u0430': { en: 'Cancel' },
    '\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C': { en: 'Add' },
    '\u0423\u0434\u0430\u043B\u0438\u0442\u044C': { en: 'Delete' },
    '\u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C': { en: 'Start' },
    '\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C': { en: 'Stop' },
    '\u041F\u0430\u0443\u0437\u0430': { en: 'Pause' },
    '\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C': { en: 'Resume' },
    '\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0440\u0430\u0441\u0441\u044B\u043B\u043A\u0443': { en: 'Create Campaign' },
    '\u041E\u0431\u0449\u0438\u0435': { en: 'General' },
    '\u0411\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C': { en: 'Security' },
    '\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F': { en: 'Notifications' },
    '\u041E\u0431\u0449\u0438\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438': { en: 'General Settings' },
    '\u042F\u0437\u044B\u043A \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430': { en: 'Interface Language' },
    '\u0427\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u043E\u044F\u0441': { en: 'Timezone' },
    '\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u0430\u044F \u0441\u043A\u043E\u0440\u043E\u0441\u0442\u044C \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E': { en: 'Default Max Speed' },
    '\u0411\u044B\u0441\u0442\u0440\u0430\u044F': { en: 'Fast' },
    '\u0421\u0440\u0435\u0434\u043D\u044F\u044F': { en: 'Medium' },
    '\u041C\u0435\u0434\u043B\u0435\u043D\u043D\u0430\u044F': { en: 'Slow' },
    '\u0414\u0432\u0443\u0445\u0444\u0430\u043A\u0442\u043E\u0440\u043D\u0430\u044F \u0430\u0443\u0442\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u044F': { en: 'Two-Factor Auth' },
    '\u0410\u0432\u0442\u043E\u043F\u0430\u0443\u0437\u0430 \u043F\u0440\u0438 FloodWait': { en: 'Auto-pause on FloodWait' },
    '\u041F\u043E\u0440\u043E\u0433 FloodWait (\u043C\u0438\u043D\u0443\u0442)': { en: 'FloodWait Threshold (min)' },
    '\u0420\u0430\u0441\u0441\u044B\u043B\u043A\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430': { en: 'Campaign Completed' },
    '\u041E\u0448\u0438\u0431\u043A\u0430 \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430': { en: 'Account Error' },
    '\u0414\u043D\u0435\u0432\u043D\u043E\u0439 \u043E\u0442\u0447\u0451\u0442': { en: 'Daily Report' },
    '\u0412\u043A\u043B\u044E\u0447\u0435\u043D\u043E': { en: 'Enabled' },
    '\u041E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u043E': { en: 'Disabled' },
    '\u041F\u0440\u043E\u0444\u0438\u043B\u044C': { en: 'Profile' },
    '\u0422\u0435\u043B\u0435\u0444\u043E\u043D': { en: 'Phone' },
    '\u0420\u043E\u043B\u044C': { en: 'Role' },
    '\u041E\u0442\u043E\u0431\u0440\u0430\u0436\u0430\u0435\u043C\u043E\u0435 \u0438\u043C\u044F': { en: 'Display Name' },
    '\u0412\u044B\u0439\u0442\u0438': { en: 'Logout' },
    '\u0412\u0441\u0435\u0433\u043E': { en: 'Total' },
    '\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0435': { en: 'Active' },
    '\u0412 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0438': { en: 'Pending' },
    '\u0417\u0430\u0431\u0430\u043D\u0435\u043D\u044B': { en: 'Banned' },
    '\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0430\u043A\u043A\u0430\u0443\u043D\u0442': { en: 'Add Account' },
    '\u041D\u043E\u043C\u0435\u0440 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430': { en: 'Phone Number' },
    '\u041F\u0440\u043E\u043A\u0441\u0438 (\u043E\u043F\u0446\u0438\u043E\u043D\u0430\u043B\u044C\u043D\u043E)': { en: 'Proxy (optional)' },
    '\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C': { en: 'Connect' },
    '\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D!': { en: 'Account added!' },
    '\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C': { en: 'Copy' },
    '\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u043E': { en: 'Copied' },
    '\u0421\u0442\u0430\u0442\u0443\u0441': { en: 'Status' },
    '\u0414\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E': { en: 'Delivered' },
    '\u041E\u0448\u0438\u0431\u043E\u043A': { en: 'Errors' },
    '\u0418\u043D\u0444\u043E': { en: 'Info' },
    '\u0422\u0435\u043C\u0430': { en: 'Theme' },
    '\u0422\u0451\u043C\u043D\u0430\u044F': { en: 'Dark' },
    '\u0421\u0432\u0435\u0442\u043B\u0430\u044F': { en: 'Light' },
  };

  function applyLanguage(lang) {
    if (lang === 'ru') {
      document.querySelectorAll('[data-en]').forEach(function(el) { el.textContent = el.getAttribute('data-ru'); });
      return;
    }
    // English mode: walk all text nodes
    document.querySelectorAll('button, label, span, p, h1, h2, h3, h4, a, li, td, th, option, div, select').forEach(function(el) {
      if (el.children.length > 0 && el.tagName !== 'SELECT' && el.tagName !== 'OPTION') return;
      var text = el.textContent.trim();
      if (!text || text.length > 60) return;
      var match = langMap[text];
      if (match && match.en) {
        el.setAttribute('data-ru', text);
        el.setAttribute('data-en', match.en);
        el.textContent = match.en;
      }
    });
    // Options in selects
    document.querySelectorAll('option').forEach(function(opt) {
      var text = opt.textContent.trim();
      var match = langMap[text];
      if (match && match.en) {
        opt.setAttribute('data-ru', text);
        opt.setAttribute('data-en', match.en);
        opt.textContent = match.en;
      }
    });
  }

  // --- WIRE ACCOUNTS PAGE ADD-ACCOUNT FLOW ---

  function wireAccountsPage() {
    // Find the "Подключить" button in the add-account modal
    var allBtns = document.querySelectorAll('button');
    for (var i = 0; i < allBtns.length; i++) {
      var btn = allBtns[i];
      if (btn._acctWired) continue;
      var text = (btn.textContent || '').trim();
      if (text !== '\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C') continue;
      if (!btn.offsetParent) continue;

      btn._acctWired = true;
      btn.addEventListener('click', function(e) {
        e.preventDefault();

        // Find phone input and proxy input in the modal
        var modal = btn.closest('.fixed.inset-0') || btn.closest('[class*="fixed"]');
        if (!modal) return;

        var inputs = modal.querySelectorAll('input[type="text"]');
        var phoneInput = inputs[0];
        var proxyInput = inputs[1] || null;
        var phone = phoneInput ? phoneInput.value.trim() : '';

        if (!phone) {
          var notifs = window.store && window.store.getState();
          if (notifs) notifs.addNotification({ message: '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u043E\u043C\u0435\u0440 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430', type: 'error' });
          return;
        }

        btn.textContent = '\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0438\u0435...';
        btn.disabled = true;

        // Add account to server
        window.api.addAccount(phone, 2, proxyInput ? proxyInput.value : '').then(function(accounts) {
          // Update store
          var store = window.store;
          if (store) {
            var st = store.getState();
            // Find phone in accounts and mark it
            var newAcc = accounts && accounts.find(function(a) { return a.phone === phone || a.phone.replace(/[^0-9]/g,'') === phone.replace(/[^0-9]/g,''); });
            if (newAcc) {
              st.addAccount({
                id: newAcc.phone,
                phone: newAcc.phone,
                status: 'waiting',
                sessionActive: false,
                limitToday: 0,
                limitMax: 50,
              });
            }
            st.addNotification({ message: '\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D! \u0422\u0435\u043F\u0435\u0440\u044C \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u0443\u0439\u0442\u0435 \u0435\u0433\u043E \u0447\u0435\u0440\u0435\u0437 \u043A\u043D\u043E\u043F\u043A\u0443 \u00AB\u0410\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u0442\u044C\u00BB', type: 'success' });
          }

          // Close modal
          var closeBtn = modal.querySelector('button');
          if (closeBtn && closeBtn.textContent.trim() === '\u2716') closeBtn.click();
          else { modal.style.display = 'none'; document.body.removeChild(modal); }
        }).catch(function(err) {
          btn.disabled = false;
          btn.textContent = '\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C';
          var notifs = window.store && window.store.getState();
          if (notifs) notifs.addNotification({ message: '\u041E\u0448\u0438\u0431\u043A\u0430: ' + (err.message || ''), type: 'error' });
        });
      }, true);
    }
  }

  // --- ACCOUNTS TOGGLE PANEL ON CAMPAIGNS PAGE ---

  function injectAccountsPanel() {
    var title = document.querySelector('h2');
    if (!title) return;
    var titleText = title.textContent || '';
    if (titleText.indexOf('Рассылки') < 0 && titleText.indexOf('Campaigns') < 0) return;

    var container = title.closest('.p-6') || title.parentElement;
    if (!container) return;

    if (document.getElementById('_accPanel')) return;

    var state = window.store && window.store.getState();
    if (!state || !state.accounts) return;
    var accounts = state.accounts;
    if (!accounts.length) return;

    var panel = document.createElement('div');
    panel.id = '_accPanel';
    panel.style.cssText = 'margin-top:24px;background:#151e2a;border:1px solid #232d3d;border-radius:12px;overflow:hidden';

    var hdr = document.createElement('div');
    hdr.style.cssText = 'padding:14px 20px;border-bottom:1px solid #232d3d;display:flex;align-items:center;justify-content:space-between';
    hdr.innerHTML = '<span style="color:#f0f4f8;font-size:13px;font-weight:600">Аккаунты</span>' +
      '<span style="color:#8896ab;font-size:11px">Вкл / Откл для рассылок</span>';
    panel.appendChild(hdr);

    accounts.forEach(function(acc) {
      var row = document.createElement('div');
      row.style.cssText = 'padding:10px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #232d3d;font-size:13px';
      row.setAttribute('data-acc-phone', acc.phone);

      var isActive = acc.active;
      var hasSession = acc.sessionActive;
      var dotColor = !isActive ? '#6b7280' : (hasSession ? '#10b981' : '#f59e0b');
      var statusText = !isActive ? 'Выключен' : (hasSession ? 'Активен' : 'Ожидание');

      var left = document.createElement('div');
      left.style.cssText = 'display:flex;align-items:center;gap:10px';
      left.innerHTML =
        '<span style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';flex-shrink:0"></span>' +
        '<span style="color:#e8edf5;font-weight:500">' + acc.phone + '</span>' +
        '<span style="color:#8896ab;font-size:11px">' + statusText + '</span>';
      row.appendChild(left);

      var right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:6px';
      right.setAttribute('data-phone', acc.phone);

      var onBtn = document.createElement('button');
      onBtn.textContent = 'Вкл';
      onBtn.style.cssText = 'padding:5px 12px;font-size:11px;border-radius:6px;border:1px solid;cursor:pointer;transition:all .15s' +
        (isActive ? ';background:rgba(16,185,129,.12);color:#34d399;border-color:rgba(16,185,129,.3)' : ';background:transparent;color:#6b7280;border-color:#232d3d');
      onBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleAccount(acc.phone, true);
      });
      right.appendChild(onBtn);

      var offBtn = document.createElement('button');
      offBtn.textContent = 'Откл';
      offBtn.style.cssText = 'padding:5px 12px;font-size:11px;border-radius:6px;border:1px solid;cursor:pointer;transition:all .15s' +
        (!isActive ? ';background:rgba(239,68,68,.12);color:#f87171;border-color:rgba(239,68,68,.3)' : ';background:transparent;color:#6b7280;border-color:#232d3d');
      offBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleAccount(acc.phone, false);
      });
      right.appendChild(offBtn);

      if (!hasSession) {
        var authBtn = document.createElement('button');
        authBtn.textContent = 'Авторизовать';
        authBtn.style.cssText = 'padding:5px 12px;font-size:11px;border-radius:6px;border:1px solid #3b82f6;background:rgba(59,130,246,.1);color:#60a5fa;cursor:pointer;transition:all .15s';
        authBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          window.dispatchEvent(new CustomEvent('open-account-auth', { detail: { phone: acc.phone } }));
        });
        right.appendChild(authBtn);
      }

      row.appendChild(right);
      panel.appendChild(row);
    });

    container.appendChild(panel);
  }

  function toggleAccount(phone, active) {
    window.api.updateAccount(phone, { active: active }).then(function() {
      refreshData(window.store);
    }).catch(function(err) {
      var st = window.store && window.store.getState();
      if (st) st.addNotification({ message: 'Ошибка: ' + (err.message || ''), type: 'error' });
      refreshData(window.store);
    });
  }

  // Listen for auth requests from the panel
  document.addEventListener('open-account-auth', function(e) {
    var phone = e.detail && e.detail.phone;
    if (phone) startAuth(phone, '');
  });

  // Init theme on load
  initTheme();

  setInterval(wireCampaignButtons, 500);
  setInterval(wireCampaignCardButtons, 500);
  setInterval(wireCsvUploadButton, 500);
  setInterval(wireModal, 500);
  setInterval(wireBellButton, 500);
  setInterval(wireProfilePopup, 500);
  setInterval(wireSettingsPage, 500);
  setInterval(wireAccountsPage, 500);
  setInterval(injectAccountsPanel, 500);
})();
