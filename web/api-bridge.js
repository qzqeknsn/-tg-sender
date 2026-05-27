var API_BASE = window.location.origin;

async function apiFetch(path, opts) {
  opts = opts || {};
  var headers = { 'Content-Type': 'application/json' };
  if (opts.headers) {
    for (var k in opts.headers) headers[k] = opts.headers[k];
  }
  var res = await fetch(API_BASE + path, {
    headers: headers,
    ...opts,
  });
  if (!res.ok) {
    var data = {};
    try { data = await res.json(); } catch (_) {}
    throw new Error(data.detail || res.statusText);
  }
  return res.json();
}

window.api = {
  getStats: function () {
    return apiFetch('/api/stats');
  },
  getCampaigns: function () {
    return apiFetch('/api/campaigns');
  },
  getChart: function () {
    return apiFetch('/api/chart/delivery');
  },
  getAccounts: function () {
    return apiFetch('/api/accounts');
  },
  getLogs: function (campaignId) {
    return apiFetch('/api/logs?campaign_id=' + encodeURIComponent(campaignId) + '&limit=50');
  },
  stopCampaign: function (id) {
    return apiFetch('/api/campaigns/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
  },
  getRecipients: function () {
    return apiFetch('/api/recipients');
  },
  saveRecipients: function (recipients) {
    return apiFetch('/api/recipients', {
      method: 'PUT',
      body: JSON.stringify({ recipients: recipients }),
    });
  },
  addAccount: function (phone, tier, notes) {
    return apiFetch('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ phone: phone, tier: tier || 2, notes: notes || '' }),
    });
  },
  deleteAccount: function (phone) {
    return apiFetch('/api/accounts/' + encodeURIComponent(phone), { method: 'DELETE' });
  },
  updateAccount: function (phone, updates) {
    return apiFetch('/api/accounts/' + encodeURIComponent(phone), {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },
  startCampaign: function (data) {
    return apiFetch('/api/campaigns/start', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  createCampaign: function (data) {
    return apiFetch('/api/campaigns/create', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  deleteCampaign: function (id) {
    return apiFetch('/api/campaigns/' + encodeURIComponent(id), { method: 'DELETE' });
  },
  health: function () {
    return apiFetch('/api/health');
  },
  healthAll: function () {
    return apiFetch('/api/accounts/health-check', { method: 'POST' });
  },
  healthOne: function (phone) {
    return apiFetch('/api/accounts/' + encodeURIComponent(phone) + '/health-check', { method: 'POST' });
  },
  getConfig: function () {
    return apiFetch('/api/config');
  },
};
