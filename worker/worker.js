// Cio Bela onboarding storage — Cloudflare Worker + KV
// KV binding name: ONBOARDING      Secret (optional): ADMIN_KEY

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

export default {
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

      return reply(request, { error: 'not found' }, 404);
    } catch (e) {
      return reply(request, { error: 'server error' }, 500);
    }
  }
};
