#!/usr/bin/env node
// The pull request gate. Usage:
//   node gate/run.mjs --base <checkout of main> --pr <checkout of the PR> --out <dir>
//                     [--pr-body <file>] [--base-built <dir>] [--pr-built <dir>] [--pr-build-failed] [--pr-build-missing <reason>]
//
// --base and --pr are read as data: the diff and the site registry come from them.
// --pr-built is the output of the untrusted build job (dist/ and worker/index.js). Without
// it, the PR is built here, which runs its npm scripts: do that only on code you trust
// (the self-test fixtures). On GitHub the PR is always built in its own job.
//
// Test tokens are drawn at random for each run, one pair for main and one for the PR.
// GATE_TEST_TOKENS=off withholds them (what happens to a pull request from a fork):
// the form cannot be tested and the verdict can never be "Checks passed".
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { computeDiff } from './lib/diff.mjs';
import { loadSites, validateSites } from './lib/sites.mjs';
import { sensitiveRule, scopeRule, phoneRule, decide, REQUIRED } from './lib/rules.mjs';
import { launch, shoot, pixelDiff, crawl, submitForm, FORM_FIELDS } from './lib/browser.mjs';
import { buildSite, prepareServeDir, serve, readStore } from './lib/serve.mjs';
import { render, clean } from './lib/render.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []));
for (const k of ['base', 'pr', 'out']) if (typeof args[k] !== 'string') { console.error(`missing --${k} <dir>\nusage: node gate/run.mjs --base <dir> --pr <dir> --out <dir> [--pr-body <file>] [--base-built <dir>] [--pr-built <dir>] [--pr-build-failed]`); process.exit(2); }
const BASE_DIR = resolve(args.base), PR_DIR = resolve(args.pr), OUT = resolve(args.out), WORK = join(OUT, '.work');
const BASE_PATH = '/demos/pr-gate-firm';
const MUTANT = process.env.GATE_MUTANT || '';
const tok = () => randomBytes(16).toString('hex');
const TOKENS = process.env.GATE_TEST_TOKENS === 'off' ? null : { base: { form: tok(), store: tok() }, pr: { form: tok(), store: tok() } };
const WAIT_MS = Number(process.env.GATE_INBOX_WAIT_MS || 20000);
const HEAD_SHA = (process.env.HEAD_SHA || 'local').slice(0, 7);
const PORTS = { base: Number(process.env.GATE_PORT_BASE || 8801), pr: Number(process.env.GATE_PORT_PR || 8802) };
mkdirSync(join(OUT, 'shots'), { recursive: true });
mkdirSync(join(OUT, 'logs'), { recursive: true });
mkdirSync(WORK, { recursive: true });

const nonce = () => randomBytes(5).toString('hex');
const results = {};
const facts = { sha: HEAD_SHA, started: new Date().toISOString(), mutant: MUTANT || null };
const children = [];

function stopAll() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} }
}
process.on('exit', stopAll);

function logSince(file, offset) {
  const text = readFileSync(file, 'utf8').slice(offset);
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.includes('"event":"lead_')) continue;
    try { out.push(JSON.parse(l.slice(l.indexOf('{')))); } catch {}
  }
  return out.slice(0, 5);
}

function built(tag, srcDir, given) {
  if (given) return { ok: true, dir: resolve(given) };
  const dir = join(WORK, `build-${tag}`);
  const r = buildSite(srcDir, dir, join(OUT, 'logs', `build-${tag}.log`));
  return { ...r, dir };
}

async function main() {
  const diff = computeDiff(BASE_DIR, PR_DIR);
  facts.changed = diff.map((f) => f.path);
  const base = loadSites(BASE_DIR), pr = loadSites(PR_DIR);
  const body = typeof args['pr-body'] === 'string' && existsSync(args['pr-body']) ? readFileSync(args['pr-body'], 'utf8') : '';

  const errors = validateSites(pr.cfg, pr.text, pr.file);
  results.config = { status: errors.length ? 'fail' : 'pass', items: errors.map((e) => ({ kind: 'fail', ...e })) };
  results.sensitive = sensitiveRule({ base, pr, diff });
  results.scope = scopeRule({ body, diff });

  const bb = built('base', BASE_DIR, args['base-built']);
  const pb = args['pr-build-failed'] ? { ok: false, tail: 'The build job for this commit failed. Its log is in the "PR gate: build" run.' }
    : typeof args['pr-build-missing'] === 'string' ? { ok: false, missing: args['pr-build-missing'] }
    : built('pr', PR_DIR, args['pr-built']);
  if (!bb.ok) results.build = { status: 'incomplete', items: [{ kind: 'incomplete', why: 'main itself does not build, so there is nothing to compare against.' }] };
  else if (pb.missing) results.build = { status: 'incomplete', items: [{ kind: 'incomplete', why: `The output of the build job is not usable: ${clean(pb.missing, 200)}` }] };
  else if (!pb.ok) results.build = { status: 'fail', items: [{ kind: 'fail', why: 'The PR does not build.', text: pb.tail }] };
  else {
    const sdb = prepareServeDir(bb.dir, join(WORK, 'serve-base')), sdp = prepareServeDir(pb.dir, join(WORK, 'serve-pr'));
    if (!sdb.ok) results.build = { status: 'incomplete', items: [{ kind: 'incomplete', why: `main's build is unusable: ${sdb.why}` }] };
    else if (!sdp.ok) results.build = { status: 'fail', items: [{ kind: 'fail', why: `The PR's build is unusable: ${sdp.why}` }] };
    else results.build = { status: 'pass', items: [] };
  }
  if (results.build.status !== 'pass') return finish();

  const vars = (t) => (t ? { FORM_TEST_TOKEN: t.form, INBOX_TOKEN: t.store } : {});
  const [sb, sp] = await Promise.all([
    serve({ serveDir: join(WORK, 'serve-base'), persist: join(WORK, 'state-base'), port: PORTS.base, vars: vars(TOKENS?.base), logFile: join(OUT, 'logs', 'worker-base.log'), basePath: BASE_PATH, children }),
    serve({ serveDir: join(WORK, 'serve-pr'), persist: join(WORK, 'state-pr'), port: PORTS.pr, vars: vars(TOKENS?.pr), logFile: join(OUT, 'logs', 'worker-pr.log'), basePath: BASE_PATH, children }),
  ]);
  if (!sb.origin || !sp.origin) {
    const mainDown = !sb.origin;
    results.build = { status: mainDown ? 'incomplete' : 'fail', items: [{ kind: mainDown ? 'incomplete' : 'fail', why: mainDown ? 'The preview of main did not start (see logs/worker-base.log), so there is nothing to compare against.' : 'The preview of this PR did not start. See logs/worker-pr.log.' }] };
    return finish();
  }
  const browser = await launch();
  try {
    const pages = ['/', '/contact/'];
    const before = await shoot(browser, sb.origin, BASE_PATH, pages, join(OUT, 'shots'), 'before');
    const after = await shoot(browser, sp.origin, BASE_PATH, pages, join(OUT, 'shots'), 'after');
    const diffs = {};
    for (const k of Object.keys(after)) diffs[k] = before[k] ? pixelDiff(before[k], after[k], join(OUT, 'shots', `diff-${k}.png`)) : { ratio: 1, newPage: true };
    results.visual = { status: 'pass', informational: true, items: [], diffs };

    const c = await crawl(browser, sp.origin, BASE_PATH);
    results.links = { status: c.broken.length ? 'fail' : 'pass', items: c.broken.map((b) => ({ kind: 'fail', why: `Dead link on ${clean(b.from, 80)}: ${clean(b.href, 120)} answers ${b.status}` })), pages: c.pages.length };
    results.phone = phoneRule({ tels: c.tels.map((t) => ({ ...t, href: clean(t.href, 60), text: clean(t.text, 60) })), site: pr.site });

    if (MUTANT !== 'no-form-check' && MUTANT !== 'form-not-run') results.form = await formCheck(browser, sb, sp, pr, diff);
  } finally {
    await browser.close();
    stopAll();
  }
  return finish();
}

async function formCheck(browser, sb, sp, pr, diff) {
  if (!TOKENS) {
    return { status: 'incomplete', items: [{ kind: 'incomplete', why: 'This run has no test tokens (a pull request from a fork is never given them), so the form was not tested and this PR cannot be cleared.' }] };
  }
  const nb = nonce(), np = nonce();
  const base = await submitForm(browser, { origin: sb.origin, base: BASE_PATH, token: TOKENS.base.form, nonce: nb, width: 390, shotFile: join(OUT, 'shots', 'form-base-390.png') });
  const storeB = base.clicked ? await readStore({ serveDir: sb.serveDir, persist: sb.persist, nonce: nb, timeoutMs: WAIT_MS }) : null;
  if (!storeB || !storeB.reachable || !storeB.messages.length || base.status !== 200) {
    const why = !storeB ? `The control submission on main failed (${base.error || 'not clicked'}).`
      : !storeB.reachable ? `The test lead store could not be read (${clean(storeB.status, 120)}).`
      : !storeB.messages.length ? `main did not record its own control lead within ${WAIT_MS / 1000} s.`
      : `On main, the page after sending answered ${base.status}.`;
    return { status: 'incomplete', items: [{ kind: 'incomplete', why: `${why} Without a working control, a missing lead proves nothing about this PR.` }], control: { nonce: nb } };
  }
  const control = { nonce: nb, waitedMs: storeB.waitedMs, heading: base.heading };
  const offset = statSync(sp.logFile).size;
  const sub = await submitForm(browser, { origin: sp.origin, base: BASE_PATH, token: TOKENS.pr.form, nonce: np, width: 390, shotFile: join(OUT, 'shots', 'form-pr-390.png') });
  if (!sub.clicked) {
    const why = sub.blocker ? `At 390 px a real tap on "Send to our intake team" never reaches the button: ${clean(sub.blocker, 160)} sits on top of it.` : `The form could not be filled or sent: ${clean(sub.error, 200)}`;
    return { status: 'fail', items: [{ kind: 'fail', why }], control, submission: { nonce: np, clicked: false } };
  }
  const store = await readStore({ serveDir: sp.serveDir, persist: sp.persist, nonce: np, timeoutMs: WAIT_MS });
  await new Promise((r) => setTimeout(r, 300));
  const log = logSince(sp.logFile, offset);
  const submission = { nonce: np, landedOn: clean(sub.landedOn, 120), status: sub.status, heading: clean(sub.heading, 160), log: log.map((l) => clean(JSON.stringify(l), 300)) };
  if (!store.reachable) return { status: 'incomplete', items: [{ kind: 'incomplete', why: `The test lead store could not be read (${clean(store.status, 120)}).` }], control, submission };

  const items = [];
  const seen = `"${submission.heading || '(no heading)'}"`;
  // What the visitor is told, compared with main.
  if (sub.status !== 200) items.push({ kind: 'fail', why: `After sending, the visitor lands on ${submission.landedOn}, which answers ${sub.status ?? 'nothing'} (on main: 200, "${clean(base.heading, 120)}").` });
  else if (sub.heading !== base.heading || sub.text !== base.text) items.push({ kind: 'fail', why: `After sending, the visitor reads ${seen}. On main the visitor reads "${clean(base.heading, 120)}".${sub.heading === base.heading ? ` The rest of the page differs too: "${clean(sub.text, 160)}".` : ''}` });

  if (!store.messages.length) {
    items.push({ kind: 'fail', why: `The visitor sees ${seen}, but no lead carrying ${np} was recorded in the test lead store after ${Math.round(store.waitedMs / 1000)} s. main recorded its control lead ${nb} ${storeB.waitedMs < 1000 ? 'within 1 s' : `in ${(storeB.waitedMs / 1000).toFixed(1)} s`}.` });
    for (const l of submission.log) items.push({ kind: 'fail', why: 'Form handler log', text: l });
    const dropped = log.find((e) => e && typeof e.field === 'string');
    if (dropped) {
      for (const f of diff) for (const r of f.removed) if (r.text.includes(`name="${dropped.field}"`)) {
        items.push({ kind: 'fail', why: `Diff line that removed the "${clean(dropped.field, 40)}" field`, file: f.path, line: r.line, text: `- ${r.text.trim()}` });
        const id = (/id="([^"]+)"/.exec(r.text) || [])[1];
        const added = f.added.find((a) => id && a.text.includes(`id="${id}"`));
        if (added) items.push({ kind: 'fail', why: 'Replaced by', file: f.path, line: added.line, text: `+ ${added.text.trim()}` });
      }
    }
    return { status: 'fail', items, control, submission };
  }

  const want = pr.site.leads.to;
  if (store.messages.length > 1) {
    items.push({ kind: 'fail', why: `${store.messages.length} records carry the test code ${np}; exactly one was expected. Recipients: ${store.messages.map((m) => clean(m.to ?? '(none)', 80)).join(', ')}. The registry routes this site's leads to ${want} only.` });
  }
  for (const msg of store.messages) {
    if (msg.unparsable) { items.push({ kind: 'fail', why: 'A record carrying the test code is not a readable lead.' }); continue; }
    if (msg.to !== want) items.push({ kind: 'fail', why: `A lead was recorded for ${clean(msg.to, 80)}. The registry routes this site's leads to ${want}: the request went to the wrong client.` });
  }
  const msg = store.messages.find((m) => m.to === want) || store.messages[0];
  for (const f of pr.site.leads.required_fields) {
    const field = FORM_FIELDS.find((x) => x.field === f);
    if (!field) items.push({ kind: 'fail', why: `The registry requires a field "${clean(f, 40)}" the gate does not know how to fill.` });
    else if (msg.fields?.[f] !== sub.typed[f]) items.push({ kind: 'fail', why: `Field ${f} was recorded as "${clean(msg.fields?.[f] ?? '(missing)', 80)}" instead of what was typed.` });
  }
  if (!items.length) submission.recorded = { to: msg.to, waitedMs: store.waitedMs, fields: Object.keys(msg.fields || {}) };
  return { status: items.length ? 'fail' : 'pass', items, control, submission };
}

function finish() {
  stopAll();
  const required = MUTANT === 'no-form-check' ? REQUIRED.filter((r) => r !== 'form') : REQUIRED;
  if (results.build && results.build.status !== 'pass') {
    for (const name of required) if (!results[name]) results[name] = { status: results.build.status, items: [{ kind: results.build.status, why: 'Not run: the build step did not pass.' }] };
  }
  const d = decide(results, required);
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref?.();
  facts.finished = new Date().toISOString();
  const out = { ...d, ...facts };
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, 'comment.md'), render(out));
  console.log(`${d.label} (${HEAD_SHA})`);
}

main().catch((e) => {
  console.error(e);
  results.build = results.build || { status: 'incomplete', items: [] };
  results.gate = { status: 'incomplete', items: [{ kind: 'incomplete', why: `The gate itself crashed: ${clean(String(e.message).split('\n')[0], 200)}` }] };
  finish();
  process.exitCode = 1;
});
