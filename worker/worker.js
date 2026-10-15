// Cio Bela onboarding storage — Cloudflare Worker + KV
// KV binding name: ONBOARDING      Secrets: ADMIN_KEY, GITHUB_TOKEN      Variable: BACKUP_REPO (e.g. Shawntyd/ciobela-onboarding-backup)

const ALLOWED_ORIGINS = ['https://shawntyd.github.io'];
const MAX_BODY = 20000;
const DONE_FIELDS = ['contract_signed','payment_signed','w9_signed','standards_signed','id_uploaded',
                     'release_signed','emergency_signed','bio_done','legal_done'];
const SERVICES = ['nail','waxing','lash','hair'];
const PAGES = ['hub','contract','payment','w9','standards','idupload','release','emergency','bio','legal'];

const TABLES = {
  contractor_profiles: {
    prefix: 'profile:',
    emailCol: 'email',
    fields: ['full_name','preferred_name','date_of_birth','phone','email','address',
             'emergency_name','emergency_phone','license_number','license_type',
             'license_expiration','created_at','updated_at']
  },
  contractor_progress: {
    prefix: 'progress:',
    emailCol: 'contractor_email',
    fields: ['contractor_email','contractor_name','contract_signed','payment_signed',
             'w9_signed','standards_signed','id_uploaded','release_signed',
             'emergency_signed','bio_done','legal_done','total_complete',
             'onboarding_done','service','created_at','updated_at']
  }
};

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function reply(request, data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, corsHeaders(request))
  });
}

function cleanEmail(e) { return String(e || '').toLowerCase().trim(); }
function validEmail(e) { return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function originBlocked(request) {
  const origin = request.headers.get('Origin');
  return !!origin && !ALLOWED_ORIGINS.includes(origin);
}

function applyVisit(rec, page, sid, start, active) {
  rec.pages = rec.pages || {};
  const iso = start.toISOString();
  const pg = rec.pages[page] || (rec.pages[page] = { first: iso, last: null, base: 0, visits: 0, sessions: {} });
  if (!pg.sessions[sid]) { pg.sessions[sid] = { start: iso, active: 0 }; pg.visits += 1; }
  pg.sessions[sid].active = Math.max(pg.sessions[sid].active, active);
  if (iso < pg.first) pg.first = iso;
  pg.last = new Date().toISOString();
  const ids = Object.keys(pg.sessions).sort(function (a, c) { return pg.sessions[a].start < pg.sessions[c].start ? -1 : 1; });
  while (ids.length > 30) { const old = ids.shift(); pg.base += pg.sessions[old].active; delete pg.sessions[old]; }
  let secs = pg.base;
  Object.keys(pg.sessions).forEach(function (s) { secs += pg.sessions[s].active; });
  pg.seconds = secs;
}

async function collectAll(env) {
  const out = { exported_at: new Date().toISOString(), profiles: [], progress: [], visits: [], anonymous_visitors: [] };
  for (const pair of [['profile:', out.profiles], ['progress:', out.progress], ['visits:', out.visits], ['anon:', out.anonymous_visitors]]) {
    let cursor;
    do {
      const page = await env.ONBOARDING.list({ prefix: pair[0], cursor: cursor });
      for (const k of page.keys) {
        pair[1].push(JSON.parse((await env.ONBOARDING.get(k.name)) || '{}'));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  return out;
}

async function backupToGitHub(env) {
  if (!env.GITHUB_TOKEN || !env.BACKUP_REPO) throw new Error('backup not configured');
  const data = await collectAll(env);
  const api = 'https://api.github.com/repos/' + env.BACKUP_REPO + '/contents/backup.json';
  const headers = {
    'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
    'User-Agent': 'ciobela-onboarding-backup',
    'Accept': 'application/vnd.github+json'
  };
  let sha;
  const cur = await fetch(api, { headers: headers });
  if (cur.ok) sha = (await cur.json()).sha;
  else if (cur.status !== 404) throw new Error('github read ' + cur.status);
  const body = {
    message: 'Nightly backup ' + data.exported_at,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))))
  };
  if (sha) body.sha = sha;
  const put = await fetch(api, { method: 'PUT', headers: headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error('github write ' + put.status);
  return { profiles: data.profiles.length, progress: data.progress.length };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(backupToGitHub(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      if (url.pathname === '/') {
        return reply(request, { ok: true, service: 'ciobela-onboarding' });
      }

      // ---- read one row ----
      if (url.pathname === '/row' && request.method === 'GET') {
        if (originBlocked(request)) return reply(request, { error: 'forbidden' }, 403);
        const t = TABLES[url.searchParams.get('table')];
        const email = cleanEmail(url.searchParams.get('email'));
        if (!t || !validEmail(email)) return reply(request, { error: 'bad request' }, 400);
        const raw = await env.ONBOARDING.get(t.prefix + email);
        return reply(request, { data: raw ? [JSON.parse(raw)] : [] });
      }

      // ---- create / update (merge) one row ----
      if (url.pathname === '/row' && request.method === 'POST') {
        if (originBlocked(request)) return reply(request, { error: 'forbidden' }, 403);
        const text = await request.text();
        if (text.length > MAX_BODY) return reply(request, { error: 'too large' }, 413);
        const body = JSON.parse(text);
        const t = TABLES[body.table];
        const email = cleanEmail(body.email);
        if (!t || !validEmail(email) || typeof body.data !== 'object' || body.data === null) {
          return reply(request, { error: 'bad request' }, 400);
        }
        const key = t.prefix + email;
        const existingRaw = await env.ONBOARDING.get(key);
        const row = existingRaw ? JSON.parse(existingRaw) : { created_at: new Date().toISOString() };
        t.fields.forEach(function (f) {
          if (!(f in body.data)) return;
          const v = body.data[f];
          if (typeof v === 'string') row[f] = v.slice(0, 500);
          else if (typeof v === 'boolean' || typeof v === 'number' || v === null) row[f] = v;
        });
        row[t.emailCol] = email;
        row.updated_at = new Date().toISOString();
        if (body.table === 'contractor_progress') {
          const before = existingRaw ? JSON.parse(existingRaw) : {};
          const doneAt = row.done_at && typeof row.done_at === 'object' ? row.done_at : {};
          DONE_FIELDS.forEach(function (f) {
            if (row[f] === true && before[f] !== true && !doneAt[f]) doneAt[f] = row.updated_at;
          });
          row.done_at = doneAt;
        }
        await env.ONBOARDING.put(key, JSON.stringify(row));
        return reply(request, { data: [row], error: null });
      }

      // ---- page visit / time-on-page tracking (known stylist or anonymous device) ----
      if (url.pathname === '/visit' && request.method === 'POST') {
        if (originBlocked(request)) return reply(request, { error: 'forbidden' }, 403);
        const text = await request.text();
        if (text.length > 2000) return reply(request, { error: 'too large' }, 413);
        const b = JSON.parse(text);
        const email = cleanEmail(b.email);
        const device = String(b.device || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
        const service = SERVICES.indexOf(b.service) > -1 ? b.service : '';
        const page = String(b.page || '');
        const sid = String(b.sid || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
        const active = Math.max(0, Math.min(86400, Math.round(Number(b.active) || 0)));
        const start = new Date(b.start);
        const haveEmail = validEmail(email);
        if ((!haveEmail && device.length < 8) || PAGES.indexOf(page) < 0 || !sid || isNaN(start.getTime())) {
          return reply(request, { error: 'bad request' }, 400);
        }
        const vkey = haveEmail ? 'visits:' + email : 'anon:' + device;
        const rec = JSON.parse((await env.ONBOARDING.get(vkey)) || '{"pages":{}}');
        if (haveEmail) rec.email = email; else { rec.device = device; rec.service = rec.service || service; }
        applyVisit(rec, page, sid, start, active);
        await env.ONBOARDING.put(vkey, JSON.stringify(rec));
        // once a visitor gives an email, mark their earlier anonymous visits as that person
        if (haveEmail && device.length >= 8) {
          const akey = 'anon:' + device;
          const araw = await env.ONBOARDING.get(akey);
          if (araw) {
            const arec = JSON.parse(araw);
            if (arec.email !== email) { arec.email = email; await env.ONBOARDING.put(akey, JSON.stringify(arec)); }
          }
        }
        return reply(request, { ok: true });
      }

      // ---- owner overview (needs ADMIN_KEY secret) ----
      if (url.pathname === '/admin' && request.method === 'GET') {
        if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
          return reply(request, { error: 'not found' }, 404);
        }
        const out = [];
        let cursor;
        do {
          const page = await env.ONBOARDING.list({ prefix: 'progress:', cursor: cursor });
          for (const k of page.keys) {
            const email = k.name.slice('progress:'.length);
            const prog = JSON.parse((await env.ONBOARDING.get(k.name)) || '{}');
            const prof = JSON.parse((await env.ONBOARDING.get('profile:' + email)) || '{}');
            const vis = JSON.parse((await env.ONBOARDING.get('visits:' + email)) || '{}');
            const pages = {};
            Object.keys(vis.pages || {}).forEach(function (p) {
              const x = vis.pages[p];
              pages[p] = { first: x.first, last: x.last, visits: x.visits, seconds: x.seconds };
            });
            out.push({ email: email, name: prof.full_name || prog.contractor_name || '', progress: prog, visits: pages });
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        const visitors = [];
        let c2;
        do {
          const pg2 = await env.ONBOARDING.list({ prefix: 'anon:', cursor: c2 });
          for (const k of pg2.keys) {
            const a = JSON.parse((await env.ONBOARDING.get(k.name)) || '{}');
            let first = null, last = null, visitsN = 0, secs = 0;
            Object.keys(a.pages || {}).forEach(function (p) {
              const x = a.pages[p];
              if (!first || x.first < first) first = x.first;
              if (!last || x.last > last) last = x.last;
              visitsN += x.visits || 0; secs += x.seconds || 0;
            });
            visitors.push({ id: String(a.device || '').slice(0, 6), service: a.service || '', email: a.email || '',
                            first: first, last: last, visits: visitsN, seconds: secs });
          }
          c2 = pg2.list_complete ? undefined : pg2.cursor;
        } while (c2);
        return reply(request, { data: out, visitors: visitors });
      }

      // ---- full export for download (needs ADMIN_KEY) ----
      if (url.pathname === '/export' && request.method === 'GET') {
        if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
          return reply(request, { error: 'not found' }, 404);
        }
        return reply(request, await collectAll(env));
      }

      // ---- run the GitHub backup right now (needs ADMIN_KEY) ----
      if (url.pathname === '/backup-now' && request.method === 'GET') {
        if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
          return reply(request, { error: 'not found' }, 404);
        }
        try { return reply(request, { ok: true, saved: await backupToGitHub(env) }); }
        catch (e) { return reply(request, { ok: false, error: String(e.message || e) }, 500); }
      }

      return reply(request, { error: 'not found' }, 404);
    } catch (e) {
      return reply(request, { error: 'server error' }, 500);
    }
  }
};
