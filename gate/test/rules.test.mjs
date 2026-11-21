import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { parseUnified } from '../lib/diff.mjs';
import { sensitiveRule, scopeRule, parseScope, phoneRule, decide } from '../lib/rules.mjs';
import { validateSites } from '../lib/sites.mjs';

const text = readFileSync(new URL('../../sites.yaml', import.meta.url), 'utf8');
const load = (t) => { const cfg = parse(t); return { text: t, cfg, site: cfg.sites[0] }; };
const base = load(text);
const fileDiff = (path, added, removed = []) => [{ path, added: added.map((t, i) => ({ line: i + 1, text: t })), removed: removed.map((t, i) => ({ line: i + 1, text: t })) }];

test('the example sites.yaml is valid', () => {
  assert.deepEqual(validateSites(base.cfg, base.text), []);
});

test('a text change that mentions DNS, env and domains triggers nothing', () => {
  const diff = fileDiff('site/src/pages/privacy/index.astro', ['<p>Cloudflare answers the DNS for our domain. No env variables or keys live in the pages.</p>']);
  assert.equal(sensitiveRule({ base, pr: base, diff }).status, 'pass');
});

test('a key renamed in code only is stopped, with its line', () => {
  const diff = fileDiff('site/worker/index.js', ['  if (!env.LEAD_FORM_TOKEN || token !== env.LEAD_FORM_TOKEN) {']);
  const r = sensitiveRule({ base, pr: base, diff });
  assert.equal(r.status, 'fail');
  assert.match(r.items[0].why, /LEAD_FORM_TOKEN/);
  assert.equal(r.items[0].line, 1);
});

test('adding a TXT verification record needs a person, with the exact line', () => {
  const t = text.replace('    dns:\n', '    dns:\n      - type: TXT\n        name: "@"\n        value: "google-site-verification=abc123"\n');
  const pr = load(t);
  const r = sensitiveRule({ base, pr, diff: fileDiff('sites.yaml', ['x']) });
  assert.equal(r.status, 'human');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].line, t.split('\n').findIndex((l) => l.includes('google-site-verification')) + 1);
});

test('changing the lead recipient in sites.yaml needs a person', () => {
  const pr = load(text.replace('to: intake@mockingbirdpike.example', 'to: intake@other.example'));
  assert.equal(sensitiveRule({ base, pr, diff: fileDiff('sites.yaml', ['x']) }).status, 'human');
});

test('touching the workflow or the gate needs a person', () => {
  for (const p of ['.github/workflows/pr-gate.yml', 'gate/run.mjs', 'site/wrangler.toml']) {
    assert.equal(sensitiveRule({ base, pr: base, diff: fileDiff(p, ['x']) }).status, 'human', p);
  }
});

test('scope: files outside the declared list need a person; no list at all too', () => {
  const body = 'Task: x\n\nFiles in scope:\n- `site/src/pages/index.astro`\n';
  assert.deepEqual(parseScope(body), ['site/src/pages/index.astro']);
  assert.equal(scopeRule({ body, diff: fileDiff('site/src/pages/index.astro', ['x']) }).status, 'pass');
  assert.equal(scopeRule({ body, diff: fileDiff('site/src/styles.css', ['x']) }).status, 'human');
  assert.equal(scopeRule({ body: 'no list', diff: [] }).status, 'human');
});

test('phone: the right text with the wrong tel: link fails', () => {
  const site = base.site;
  assert.equal(phoneRule({ tels: [{ page: '/', href: 'tel:+15125550147', text: '(512) 555-0147' }], site }).status, 'pass');
  assert.equal(phoneRule({ tels: [{ page: '/', href: 'tel:+15125550174', text: 'Call (512) 555-0147' }], site }).status, 'fail');
  assert.equal(phoneRule({ tels: [], site }).status, 'fail');
});

test('a required check that did not run is a failure, never a pass', () => {
  const pass = { status: 'pass', items: [] };
  const all = { build: pass, config: pass, sensitive: pass, scope: pass, visual: pass, links: pass, phone: pass };
  assert.equal(decide(all).verdict, 'changes-needed');
  assert.equal(decide({ ...all, form: pass }).verdict, 'checks-passed');
});

test('incomplete outranks a human decision; failure outranks both', () => {
  const pass = { status: 'pass', items: [] };
  const all = { build: pass, config: pass, sensitive: { status: 'human', items: [] }, scope: pass, visual: pass, links: pass, phone: pass, form: { status: 'incomplete', items: [] } };
  assert.equal(decide(all).verdict, 'verification-incomplete');
  assert.equal(decide({ ...all, form: pass }).verdict, 'human-decision');
  assert.equal(decide({ ...all, links: { status: 'fail', items: [] } }).verdict, 'changes-needed');
});

test('diff parser keeps line numbers of added and removed lines', () => {
  const d = parseUnified('--- a/x\n+++ b/site/x.astro\n@@ -12 +12 @@\n-  <textarea name="case_details">\n+  <textarea name="message">\n');
  assert.equal(d[0].path, 'site/x.astro');
  assert.equal(d[0].removed[0].line, 12);
  assert.equal(d[0].added[0].line, 12);
});
