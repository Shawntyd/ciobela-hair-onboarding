/* Cio Bela onboarding storage client.
   Replaces the old database library: same calls, now stored through the Cloudflare Worker. */
(function () {
  var API = 'https://ciobela-onboarding.shawntyd96.workers.dev';
  var EMAIL_COL = { contractor_profiles: 'email', contractor_progress: 'contractor_email' };

  var SERVICE = (function () {
    var p = location.pathname.toLowerCase();
    return p.indexOf('hair') > -1 ? 'hair' : p.indexOf('waxing') > -1 ? 'waxing' : p.indexOf('lash') > -1 ? 'lash' : 'nail';
  })();

  function Query(table) { this.t = table; this.op = 'select'; this.payload = null; this.val = null; }
  Query.prototype.select = function () { return this; };
  Query.prototype.update = function (d) { this.op = 'update'; this.payload = d; return this; };
  Query.prototype.insert = function (d) { this.op = 'insert'; this.payload = d; return this; };
  Query.prototype.upsert = function (d) { this.op = 'upsert'; this.payload = d; return this; };
  Query.prototype.eq = function (col, val) { this.val = val; return this; };
  Query.prototype.then = function (ok, bad) { return this._run().then(ok, bad); };
  Query.prototype['catch'] = function (bad) { return this._run().then(null, bad); };

  Query.prototype._run = function () {
    var t = this.t, op = this.op, payload = this.payload;
    var email = String(this.val || (payload && payload[EMAIL_COL[t]]) || '').toLowerCase().trim();
    function fail(e) { return { data: null, error: { message: String((e && e.message) || e) } }; }
    if (!EMAIL_COL[t] || !email) return Promise.resolve({ data: null, error: { message: 'bad request' } });
    try {
      if (op === 'select') {
        return fetch(API + '/row?table=' + encodeURIComponent(t) + '&email=' + encodeURIComponent(email))
          .then(function (r) { return r.json(); })
          .then(function (j) { return j && j.data ? { data: j.data, error: null } : { data: null, error: { message: (j && j.error) || 'error' } }; })
          .catch(fail);
      }
      return fetch(API + '/row', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: t, email: email, data: (function () {
          var d = {}, k; payload = payload || {};
          for (k in payload) d[k] = payload[k];
          if (t === 'contractor_progress') d.service = SERVICE;
          return d;
        })() })
      })
        .then(function (r) { return r.json(); })
        .then(function (j) { return j && j.data ? { data: j.data, error: null } : { data: null, error: { message: (j && j.error) || 'error' } }; })
        .catch(fail);
    } catch (e) { return Promise.resolve(fail(e)); }
  };

  window.supabase = {
    createClient: function () { return { from: function (table) { return new Query(table); } }; }
  };
})();

/* Auto-fill: puts the stylist's saved profile into any matching form field (only fields left empty). */
(function () {
  var MAP = {
    'cont-name': 'fullName', 'c-name': 'fullName', 'f-fullname': 'fullName',
    'cont-preferred': 'preferredName', 'c-preferred': 'preferredName',
    'f-display-name': 'preferredName|fullName',
    'cont-phone': 'phone', 'c-phone': 'phone', 'sig-phone': 'phone',
    'cont-email': 'email', 'c-email': 'email', 'sig-email': 'email', 'f-email': 'email',
    'cont-dob': 'dateOfBirth', 'c-dob': 'dateOfBirth',
    'cont-address': 'address', 'c-address': 'address',
    'cont-license': 'licenseNumber', 'lic-num': 'licenseNumber', 'sig-license': 'licenseNumber',
    'cont-lic-exp': 'licenseExpiration', 'lic-exp': 'licenseExpiration',
    'emerg-name': 'emergencyName', 'emerg-phone': 'emergencyPhone',
    'ec1-name': 'emergencyName', 'ec1-phone': 'emergencyPhone'
  };
  var SNAKE = { fullName: 'full_name', preferredName: 'preferred_name', dateOfBirth: 'date_of_birth',
    licenseNumber: 'license_number', licenseExpiration: 'license_expiration',
    emergencyName: 'emergency_name', emergencyPhone: 'emergency_phone' };

  function pick(p, key) {
    var keys = key.split('|');
    for (var i = 0; i < keys.length; i++) {
      var v = p[keys[i]] || p[SNAKE[keys[i]]];
      if (v) return v;
    }
    return '';
  }
  function fill(p) {
    if (!p) return;
    Object.keys(MAP).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || el.value) return;
      var v = pick(p, MAP[id]);
      if (!v) return;
      el.value = v;
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
    });
  }
  function read(store, key) {
    try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function run() {
    var em = '';
    try { em = (new URLSearchParams(location.search).get('email') || '').toLowerCase().trim(); } catch (e) {}
    var p = read(window.sessionStorage, 'cb_prefill');
    if (!p) {
      var saved = read(window.localStorage, 'cb_p');
      if (saved && (!em || String(saved.email || '').toLowerCase().trim() === em)) p = saved;
    }
    fill(p);
    if (em) {
      try {
        window.supabase.createClient().from('contractor_profiles').select('*').eq('email', em)
          .then(function (r) { if (r && r.data && r.data.length) fill(r.data[0]); });
      } catch (e) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();

/* Page tracker: records when each document is opened and how long the stylist is actively on it. */
(function () {
  var API = 'https://ciobela-onboarding.shawntyd96.workers.dev';
  var f = (location.pathname.split('/').pop() || '').toLowerCase();
  var PAGE = /hub/.test(f) ? 'hub' : /contract/.test(f) ? 'contract' : /payment/.test(f) ? 'payment'
    : /w9/.test(f) ? 'w9' : /brand-standards/.test(f) ? 'standards' : /id-upload/.test(f) ? 'idupload'
    : /photo-release/.test(f) ? 'release' : /emergency/.test(f) ? 'emergency'
    : /bio/.test(f) ? 'bio' : /legal/.test(f) ? 'legal' : '';
  if (!PAGE) return;

  var sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var start = new Date().toISOString();
  var active = 0, lastAct = Date.now(), sent = -1, opened = false;
  var IDLE_MS = 120000;

  function note() { lastAct = Date.now(); }
  ['pointerdown', 'keydown', 'scroll', 'touchstart', 'mousemove', 'input'].forEach(function (ev) {
    window.addEventListener(ev, note, { passive: true, capture: true });
  });

  function readJSON(store, key) { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } }
  function email() {
    var e = '';
    try { e = (new URLSearchParams(location.search).get('email') || ''); } catch (x) {}
    if (!e) { var p = readJSON(window.sessionStorage, 'cb_prefill'); e = (p && p.email) || ''; }
    if (!e) { var q = readJSON(window.localStorage, 'cb_p'); e = (q && q.email) || ''; }
    e = String(e).toLowerCase().trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
  }

  function send() {
    var em = email();
    if (!em) return;
    if (opened && active === sent) return;
    opened = true; sent = active;
    try {
      fetch(API + '/visit', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: em, page: PAGE, sid: sid, start: start, active: active })
      }).catch(function () {});
    } catch (e) {}
  }

  setInterval(function () {
    if (document.visibilityState === 'visible' && Date.now() - lastAct < IDLE_MS) active += 1;
  }, 1000);
  setInterval(send, 10000);
  setTimeout(send, 1500);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(); });
  window.addEventListener('pagehide', send);
})();
