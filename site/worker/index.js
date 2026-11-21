// Serves the fictional firm's site and its contact form handler.
// A lead is accepted only when the request carries the test token: this is a
// fictional firm, and real visitors must never believe their message was sent.
import site from '../src/site.json';

const BASE = '/demos/pr-gate-firm';
const ROBOTS = 'noindex, nofollow';
// Lead routing shared with the other firm sites.
const LEAD_TO = 'intake@pecan-street-dental.example';

function log(event, data) {
  console.log(JSON.stringify({ event, ...data }));
}

function redirect(origin, path) {
  return new Response(null, { status: 303, headers: { Location: `${origin}${BASE}${path}`, 'X-Robots-Tag': ROBOTS } });
}

async function contact(request, env, origin) {
  const token = request.headers.get('x-form-test-token');
  if (!env.FORM_TEST_TOKEN || token !== env.FORM_TEST_TOKEN) {
    log('lead_refused', { reason: 'no test token: fictional firm, nothing stored' });
    return redirect(origin, '/not-sent/');
  }
  const form = await request.formData();
  const fields = {};
  for (const name of site.leads.required_fields) {
    const value = (form.get(name) || '').toString().trim();
    if (!value) {
      // Spam filters drop incomplete posts quietly; the visitor still sees the thank-you page.
      log('lead_dropped', { reason: 'missing required field', field: name, received: [...form.keys()] });
      return redirect(origin, '/thanks/');
    }
    fields[name] = value;
  }
  const id = crypto.randomUUID();
  const message = { id, to: LEAD_TO, site: site.id, subject: `New intake request from ${fields.name}`, fields, received_at: new Date().toISOString() };
  await env.INBOX.put(`msg:${message.received_at}:${id}`, JSON.stringify(message), { expirationTtl: 60 * 60 * 24 * 14 });
  log('lead_delivered', { id, to: message.to });
  return redirect(origin, '/thanks/');
}

async function inbox(request, env, url) {
  if (!env.INBOX_TOKEN) return Response.json({ error: 'inbox token not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${env.INBOX_TOKEN}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const needle = url.searchParams.get('contains') || '';
  if (needle.length < 8) return Response.json({ error: 'contains= must be at least 8 characters' }, { status: 400 });
  const list = await env.INBOX.list({ prefix: 'msg:' });
  const messages = [];
  for (const key of list.keys.slice(-200)) {
    const raw = await env.INBOX.get(key.name);
    if (raw && raw.includes(needle)) messages.push(JSON.parse(raw));
  }
  return Response.json({ messages }, { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': ROBOTS } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === BASE) return Response.redirect(`${url.origin}${BASE}/`, 308);
    if (!url.pathname.startsWith(BASE + '/')) return new Response('Not found', { status: 404 });
    const path = url.pathname.slice(BASE.length) || '/';
    if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });
    if (path === '/api/contact/' || path === '/api/contact') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      return contact(request, env, url.origin);
    }
    if (path === '/__inbox') return inbox(request, env, url);
    const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin), request));
    const out = new Response(res.body, res);
    const loc = out.headers.get('Location');
    if (loc && loc.startsWith('/')) out.headers.set('Location', BASE + loc);
    out.headers.set('X-Robots-Tag', ROBOTS);
    return out;
  },
};
