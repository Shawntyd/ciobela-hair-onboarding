// Cio Bela onboarding storage — Cloudflare Worker + KV
// KV binding name: ONBOARDING      Secrets: ADMIN_KEY, GITHUB_TOKEN      Variable: BACKUP_REPO (e.g. Shawntyd/ciobela-onboarding-backup)

const ALLOWED_ORIGINS = ['https://shawntyd.github.io'];
const MAX_BODY = 20000;

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

async function collectAll(env) {
  const out = { exported_at: new Date().toISOString(), profiles: [], progress: [] };
  for (const pair of [['profile:', out.profiles], ['progress:', out.progress]]) {
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
        await env.ONBOARDING.put(key, JSON.stringify(row));
        return reply(request, { data: [row], error: null });
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
            out.push({ email: email, name: prof.full_name || prog.contractor_name || '', progress: prog });
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        return reply(request, { data: out });
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
