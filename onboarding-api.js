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

  var SVC = /hair/.test(location.pathname.toLowerCase()) ? 'hair' : /waxing/.test(location.pathname.toLowerCase()) ? 'waxing'
    : /lash/.test(location.pathname.toLowerCase()) ? 'lash' : 'nail';
  function deviceId() {
    var d = '';
    try { d = localStorage.getItem('cb_dev') || ''; } catch (e) {}
    if (!d) {
      d = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      try { localStorage.setItem('cb_dev', d); } catch (e) {}
    }
    return d;
  }
  var DEVICE = deviceId();
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
    if (opened && active === sent) return;
    opened = true; sent = active;
    try {
      fetch(API + '/visit', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: em, device: DEVICE, service: SVC, page: PAGE, sid: sid, start: start, active: active })
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

/* Answer saver: when a form's thank-you screen appears after Submit, sends a copy of the answers to the
   owner dashboard in the background. It never blocks Submit or the PDF. W-9 and payment pages are skipped,
   and so are ID numbers, bank/card fields and photo uploads. */
(function () {
  var API = 'https://ciobela-onboarding.shawntyd96.workers.dev';
  var path = location.pathname.toLowerCase();
  var FORM = (path.split('/').pop() || '').replace(/\.html?$/, '').replace(/^cio-bela-/, '');
  if (!FORM || /hub|owner|w9|payment/.test(FORM)) return;
  var SVC = /hair/.test(path) ? 'hair' : /waxing/.test(path) ? 'waxing' : /lash/.test(path) ? 'lash' : 'nail';
  var SKIP_TYPE = /^(file|password|hidden|button|submit|reset|image)$/;
  var SKIP_ID = /(^|-)(id-num|ssn|tin|ein|routing|acct|account|card|cvv|cvc)(-|$)|^bank-|^deb-|^cc\d|^c-blood$/;
  // medical and insurance details stay in the PDF only
  var SKIP_SECTION = /medical|insurance|safety preferences/i;

  function clean(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim(); }
  function textOf(n) {
    if (!n) return '';
    var c = n.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('input,select,textarea,script,style,.req'), function (x) {
      if (x.parentNode) x.parentNode.removeChild(x);
    });
    return clean(c.textContent);
  }
  function readJSON(store, key) { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } }
  function email() {
    var e = '';
    try { e = (new URLSearchParams(location.search).get('email') || ''); } catch (x) {}
    if (!e) { var p = readJSON(window.sessionStorage, 'cb_prefill'); e = (p && p.email) || ''; }
    if (!e) { var q = readJSON(window.localStorage, 'cb_p'); e = (q && q.email) || ''; }
    e = String(e).toLowerCase().trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
  }
  function ownLabel(el) {
    var lab = null;
    if (el.id) { try { lab = document.querySelector('label[for="' + el.id + '"]'); } catch (e) {} }
    if (!lab) lab = el.closest('label');
    if (!lab && /^(checkbox|radio)$/i.test(el.type || '')) {
      var card = el.closest('[class*="card"], [class*="item"], li');
      lab = card && card.querySelector('[class*="title"], strong');
    }
    return lab ? textOf(lab) : '';
  }
  function groupLabel(el) {
    var g = el.closest('.field-group, .form-group, .field, .fg, .sign-field, .check-group, .yn-group');
    var l = g && g.querySelector('.field-label, .dl, legend');
    if (!l && g) { var x = g.querySelector('label'); if (x && !x.contains(el)) l = x; }
    if (!l && el.parentElement) {
      Array.prototype.some.call(el.parentElement.children, function (c) {
        if (c !== el && (/^(LABEL|LEGEND)$/.test(c.tagName) || /(^|\s)(field-label|dl)(\s|$)/.test(c.className || ''))) {
          if (!c.contains(el)) { l = c; return true; }
        }
        return false;
      });
    }
    return l ? textOf(l) : '';
  }
  function itemName(el) {
    var it = el.closest('.svc-item, .service-item, .svc-row');
    var n = it && it.querySelector('strong, .svc-title, .service-name');
    return n ? clean(n.textContent) : '';
  }
  function entry(el, section) {
    var type = String(el.type || '').toLowerCase();
    if (SKIP_TYPE.test(type) || el.disabled || SKIP_ID.test(String(el.id || el.name || '').toLowerCase())) return null;
    if (el.closest('#success') || el.closest('.svc-detail:not(.show)')) return null;
    var item = itemName(el), label = '', value = '';
    if (type === 'checkbox' || type === 'radio') {
      if (!el.checked) return null;
      var opt = ownLabel(el), grp = groupLabel(el);
      if (item) { label = item; value = opt || el.value || 'Yes'; }
      else if (grp && opt && grp !== opt) { label = grp; value = opt; }
      else { label = opt || grp || el.name || el.id; value = type === 'radio' ? (el.value || 'Yes') : 'Yes'; }
    } else {
      if (el.tagName === 'SELECT') { var o = el.options[el.selectedIndex]; value = o && el.value ? clean(o.text) : ''; }
      else value = String(el.value || '').trim();
      if (!value) return null;
      var own = groupLabel(el) || ownLabel(el) ||
        clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '');
      label = item && own !== item ? item + ' · ' + own : (item || own);
    }
    return { s: section.slice(0, 80), l: clean(label).slice(0, 160), v: String(value).slice(0, 1500) };
  }
  function collect() {
    var out = [], section = '';
    var nodes = document.querySelectorAll('.section-divider, .section-title, .sec-label, h2, h3, input, select, textarea');
    Array.prototype.forEach.call(nodes, function (n) {
      if (n.closest('#success')) return;
      if (!/^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName)) { var t = clean(n.textContent); if (t) section = t; return; }
      if (SKIP_SECTION.test(section)) return;
      var e = entry(n, section);
      if (e && e.v) out.push(e);
    });
    return out.slice(0, 300);
  }
  function send() {
    var em = email();
    if (!em) return;
    try {
      fetch(API + '/answers', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: em, service: SVC, form: FORM, items: collect() })
      }).catch(function () {});
    } catch (e) {}
  }
  function shown(el) {
    if (el.classList.contains('active')) return true;
    var d = el.style.display;
    return !!d && d !== 'none';
  }
  function watch() {
    var el = document.getElementById('success');
    if (!el || !window.MutationObserver) return;
    var was = shown(el), sent = false;
    new MutationObserver(function () {
      var now = shown(el);
      if (now && !was && !sent) { sent = true; try { send(); } catch (e) {} }
      was = now;
    }).observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  window.CioAnswers = { form: FORM, collect: collect };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();

/* Photos: shrinks uploaded pictures on the phone. On the ID page, the headshot and cosmetology license photos
   are sent to the owner dashboard when the thank-you screen appears. Government ID photos are never sent;
   the ID page puts them inside its PDF instead. */
(function () {
  var API = 'https://ciobela-onboarding.shawntyd96.workers.dev';
  var path = location.pathname.toLowerCase();

  function shrink(file, maxSide, quality) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type || '') || !window.URL || !URL.createObjectURL) { resolve(null); return; }
      var url, finished = false;
      function done(v) { if (finished) return; finished = true; try { URL.revokeObjectURL(url); } catch (e) {} resolve(v); }
      try { url = URL.createObjectURL(file); } catch (e) { resolve(null); return; }
      var img = new Image();
      img.onload = function () {
        try {
          var s = Math.min(1, (maxSide || 1600) / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          var x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h);
          done({ data: c.toDataURL('image/jpeg', quality || 0.82), w: w, h: h });
        } catch (e) { done(null); }
      };
      img.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 20000);
      img.src = url;
    });
  }
  window.CioPhotos = { shrink: shrink };

  if (!/id-upload/.test(path)) return;
  var SVC = /hair/.test(path) ? 'hair' : /waxing/.test(path) ? 'waxing' : /lash/.test(path) ? 'lash' : 'nail';
  var SLOTS = { 'up-headshot': 'headshot', 'up-lic': 'license-front', 'up-lic-back': 'license-back' };
  var ready = {};

  function readJSON(store, key) { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } }
  function email() {
    var e = '';
    try { e = (new URLSearchParams(location.search).get('email') || ''); } catch (x) {}
    if (!e) { var p = readJSON(window.sessionStorage, 'cb_prefill'); e = (p && p.email) || ''; }
    if (!e) { var q = readJSON(window.localStorage, 'cb_p'); e = (q && q.email) || ''; }
    e = String(e).toLowerCase().trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
  }
  function upload() {
    var em = email();
    if (!em) return;
    Object.keys(SLOTS).forEach(function (id) {
      var p = ready[id];
      if (!p) return;
      p.then(function (img) {
        if (!img) return;
        try {
          fetch(API + '/photo', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: em, service: SVC, slot: SLOTS[id], data: img.data })
          }).catch(function () {});
        } catch (e) {}
      });
    });
  }
  function setup() {
    Object.keys(SLOTS).forEach(function (id) {
      var input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        ready[id] = f ? shrink(f, 1600, 0.82) : null;
      });
    });
    var el = document.getElementById('success');
    if (!el || !window.MutationObserver) return;
    var shown = function () { return el.classList.contains('active') || (!!el.style.display && el.style.display !== 'none'); };
    var was = shown(), sent = false;
    new MutationObserver(function () {
      var now = shown();
      if (now && !was && !sent) { sent = true; try { upload(); } catch (e) {} }
      was = now;
    }).observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
