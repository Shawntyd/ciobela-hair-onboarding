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
