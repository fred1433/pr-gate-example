#!/usr/bin/env node
// Runs against the live test site after each deploy or rollback:
// pages answer, a visitor without the test token is told nothing was sent,
// and a tokened test submission really lands in the inbox.
// Env: LIVE_FORM_TEST_TOKEN, LIVE_INBOX_TOKEN. Optional: LIVE_ORIGIN (default https://theaipipe.com)
import { randomBytes } from 'node:crypto';
import { launch, submitForm, readInbox } from '../gate/lib/browser.mjs';

const ORIGIN = process.env.LIVE_ORIGIN || 'https://theaipipe.com';
const BASE = '/demos/pr-gate-firm';
const { LIVE_FORM_TEST_TOKEN: form, LIVE_INBOX_TOKEN: inbox } = process.env;
if (!form || !inbox) { console.error('LIVE_FORM_TEST_TOKEN and LIVE_INBOX_TOKEN are required'); process.exit(2); }

const lines = [];
let ok = true;
for (const p of ['/', '/contact/', '/attorneys/']) {
  const r = await fetch(`${ORIGIN}${BASE}${p}`, { headers: { 'cache-control': 'no-cache' } });
  const good = r.status === 200 && (r.headers.get('x-robots-tag') || '').includes('noindex');
  ok &&= good;
  lines.push(`${good ? 'ok  ' : 'FAIL'} GET ${BASE}${p} -> ${r.status}, x-robots-tag: ${r.headers.get('x-robots-tag')}`);
}
const browser = await launch();
const stranger = await submitForm(browser, { origin: ORIGIN, base: BASE, token: '', nonce: 'visitor', width: 390, shotFile: null }).catch((e) => ({ error: e.message }));
const strangerOk = stranger.landedOn === `${BASE}/not-sent/`;
ok &&= strangerOk;
lines.push(`${strangerOk ? 'ok  ' : 'FAIL'} visitor without test token lands on ${stranger.landedOn || stranger.error} ("${stranger.heading || ''}")`);
const nonce = randomBytes(5).toString('hex');
const sub = await submitForm(browser, { origin: ORIGIN, base: BASE, token: form, nonce, width: 390, shotFile: null });
await browser.close();
const got = sub.clicked ? await readInbox({ origin: ORIGIN, base: BASE, token: inbox, nonce, timeoutMs: 90000 }) : null;
const msg = got?.messages?.[0];
const formOk = Boolean(msg && msg.to === 'intake@mockingbirdpike.example' && msg.fields?.case_details?.includes(nonce));
ok &&= formOk;
lines.push(`${formOk ? 'ok  ' : 'FAIL'} test lead ${nonce}: page "${sub.heading || sub.error}", inbox ${msg ? `has it for ${msg.to} after ${Math.round(got.waitedMs / 1000)} s` : `does not have it (${got ? (got.reachable ? 'not arrived after 90 s' : 'unreachable: ' + got.status) : 'not submitted'})`}`);
console.log(lines.join('\n'));
console.log(ok ? 'POST-DEPLOY CHECK PASSED' : 'POST-DEPLOY CHECK FAILED');
process.exit(ok ? 0 : 1);
