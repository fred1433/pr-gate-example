#!/usr/bin/env node
// The pull request gate. Usage:
//   node gate/run.mjs --base <checkout of main> --pr <checkout of the PR> --out <dir> [--pr-body <file>]
// Secrets read from the environment: FORM_TEST_TOKEN, INBOX_TOKEN. Without them the
// form cannot be tested and the verdict can never be "Checks passed".
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { computeDiff } from './lib/diff.mjs';
import { loadSites, validateSites } from './lib/sites.mjs';
import { sensitiveRule, scopeRule, phoneRule, decide, REQUIRED } from './lib/rules.mjs';
import { launch, shoot, pixelDiff, crawl, submitForm, readInbox, FORM_FIELDS } from './lib/browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
for (const k of ['base', 'pr', 'out']) if (!args[k]) { console.error(`missing --${k}\nusage: node gate/run.mjs --base <dir> --pr <dir> --out <dir> [--pr-body <file>]`); process.exit(2); }
const BASE_DIR = resolve(args.base), PR_DIR = resolve(args.pr), OUT = resolve(args.out);
const BASE_PATH = '/demos/pr-gate-firm';
const MUTANT = process.env.GATE_MUTANT || '';
const TOKENS = { form: process.env.FORM_TEST_TOKEN || '', inbox: process.env.INBOX_TOKEN || '' };
const INBOX_WAIT_MS = Number(process.env.GATE_INBOX_WAIT_MS || 20000);
const HEAD_SHA = (process.env.HEAD_SHA || 'local').slice(0, 7);
const PORTS = { base: Number(process.env.GATE_PORT_BASE || 8801), pr: Number(process.env.GATE_PORT_PR || 8802) };
mkdirSync(join(OUT, 'shots'), { recursive: true });
mkdirSync(join(OUT, 'logs'), { recursive: true });

const nonce = () => randomBytes(5).toString('hex');
const results = {};
const facts = { sha: HEAD_SHA, started: new Date().toISOString(), mutant: MUTANT || null };
const children = [];

function cleanEnv() {
  const env = { ...process.env };
  delete env.FORM_TEST_TOKEN; delete env.INBOX_TOKEN; delete env.GITHUB_TOKEN; delete env.CLOUDFLARE_API_TOKEN;
  return env;
}

function build(dir, tag) {
  const r = spawnSync('npm', ['run', 'build'], { cwd: join(dir, 'site'), env: cleanEnv(), encoding: 'utf8' });
  writeFileSync(join(OUT, 'logs', `build-${tag}.log`), (r.stdout || '') + (r.stderr || ''));
  return { ok: r.status === 0, tail: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-6).join('\n') };
}

async function serve(dir, tag, port) {
  const vars = [];
  if (TOKENS.form) vars.push(`FORM_TEST_TOKEN=${TOKENS.form}`);
  if (TOKENS.inbox) vars.push(`INBOX_TOKEN=${process.env.GATE_INBOX_TOKEN_SERVER_OVERRIDE || TOKENS.inbox}`);
  writeFileSync(join(dir, 'site', '.dev.vars'), vars.join('\n') + '\n');
  const logFile = join(OUT, 'logs', `worker-${tag}.log`);
  writeFileSync(logFile, '');
  const env = cleanEnv();
  const child = spawn(join(dir, 'site', 'node_modules', '.bin', 'wrangler'),
    ['dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1000), '--persist-to', join(OUT, `.gate-state-${tag}`), '--show-interactive-dev-session=false', '--log-level', 'log'],
    { cwd: join(dir, 'site'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const { appendFileSync } = await import('node:fs');
  child.stdout.on('data', (d) => appendFileSync(logFile, d));
  child.stderr.on('data', (d) => appendFileSync(logFile, d));
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${origin}${BASE_PATH}/`); if (r.status === 200) return { origin, logFile }; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { origin: null, logFile };
}

function stopAll() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} }
}
process.on('exit', stopAll);

function logSince(file, offset) {
  const text = readFileSync(file, 'utf8').slice(offset);
  return text.split('\n').filter((l) => l.includes('"event":"lead_')).map((l) => l.slice(l.indexOf('{')).trim());
}

async function main() {
  const diff = computeDiff(BASE_DIR, PR_DIR);
  facts.changed = diff.map((f) => f.path);
  const base = loadSites(BASE_DIR), pr = loadSites(PR_DIR);
  const body = args['pr-body'] && existsSync(args['pr-body']) ? readFileSync(args['pr-body'], 'utf8') : '';

  const errors = validateSites(pr.cfg, pr.text);
  results.config = { status: errors.length ? 'fail' : 'pass', items: errors.map((e) => ({ kind: 'fail', ...e })) };
  results.sensitive = sensitiveRule({ base, pr, diff });
  results.scope = scopeRule({ body, diff });

  const bb = build(BASE_DIR, 'base'), pb = build(PR_DIR, 'pr');
  if (!bb.ok) results.build = { status: 'incomplete', items: [{ kind: 'incomplete', why: 'main itself does not build, so there is nothing to compare against.' }] };
  else if (!pb.ok) results.build = { status: 'fail', items: [{ kind: 'fail', why: 'The PR does not build.', text: pb.tail }] };
  else results.build = { status: 'pass', items: [] };
  if (results.build.status !== 'pass') return finish(diff);

  const [sb, sp] = await Promise.all([serve(BASE_DIR, 'base', PORTS.base), serve(PR_DIR, 'pr', PORTS.pr)]);
  if (!sb.origin || !sp.origin) {
    const mainDown = !sb.origin;
    results.build = { status: mainDown ? 'incomplete' : 'fail', items: [{ kind: mainDown ? 'incomplete' : 'fail', why: mainDown ? 'The preview of main did not start (see logs/worker-base.log), so there is nothing to compare against.' : 'The preview of this PR did not start. See logs/worker-pr.log.' }] };
    return finish(diff);
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
    results.links = { status: c.broken.length ? 'fail' : 'pass', items: c.broken.map((b) => ({ kind: 'fail', why: `Dead link on ${b.from}: ${b.href} answers ${b.status}` })), pages: c.pages.length };
    results.phone = phoneRule({ tels: c.tels, site: pr.site });

    if (MUTANT !== 'no-form-check' && MUTANT !== 'form-not-run') results.form = await formCheck(browser, sb, sp, pr, diff);
  } finally {
    await browser.close();
    stopAll();
  }
  return finish(diff);
}

async function formCheck(browser, sb, sp, pr, diff) {
  if (!TOKENS.form || !TOKENS.inbox) {
    return { status: 'incomplete', items: [{ kind: 'incomplete', why: 'The test-submission secrets are not available to this run (a pull request from a fork receives none). The form was not tested, so this PR cannot be cleared.' }] };
  }
  const nb = nonce(), np = nonce();
  const base = await submitForm(browser, { origin: sb.origin, base: BASE_PATH, token: TOKENS.form, nonce: nb, width: 390, shotFile: join(OUT, 'shots', 'form-base-390.png') });
  const inboxB = base.clicked ? await readInbox({ origin: sb.origin, base: BASE_PATH, token: TOKENS.inbox, nonce: nb, timeoutMs: INBOX_WAIT_MS }) : null;
  if (!inboxB || !inboxB.reachable || !inboxB.messages.length) {
    const why = !inboxB ? `The control submission on main failed (${base.error || 'not clicked'}).`
      : !inboxB.reachable ? `The test inbox could not be read (answer: ${inboxB.status}).`
      : `main did not deliver its own control message within ${INBOX_WAIT_MS / 1000} s.`;
    return { status: 'incomplete', items: [{ kind: 'incomplete', why: `${why} Without a working control, a missing message proves nothing about this PR.` }], control: { nonce: nb } };
  }
  const offset = statSync(sp.logFile).size;
  const sub = await submitForm(browser, { origin: sp.origin, base: BASE_PATH, token: TOKENS.form, nonce: np, width: 390, shotFile: join(OUT, 'shots', 'form-pr-390.png') });
  const control = { nonce: nb, waitedMs: inboxB.waitedMs };
  if (!sub.clicked) {
    const why = sub.blocker ? `At 390 px a real tap on "Send to our intake team" never reaches the button: ${sub.blocker} sits on top of it.` : `The form could not be filled or sent: ${sub.error}`;
    return { status: 'fail', items: [{ kind: 'fail', why }], control, submission: { nonce: np, ...sub } };
  }
  const inbox = await readInbox({ origin: sp.origin, base: BASE_PATH, token: TOKENS.inbox, nonce: np, timeoutMs: INBOX_WAIT_MS });
  await new Promise((r) => setTimeout(r, 300));
  const log = logSince(sp.logFile, offset);
  const submission = { nonce: np, landedOn: sub.landedOn, heading: sub.heading, log };
  if (!inbox.reachable) return { status: 'incomplete', items: [{ kind: 'incomplete', why: `The test inbox could not be read (answer: ${inbox.status}).` }], control, submission };
  if (!inbox.messages.length) {
    const items = [{ kind: 'fail', why: `The visitor sees "${sub.heading}", but no message carrying ${np} reached the inbox after ${Math.round(inbox.waitedMs / 1000)} s. main delivered its control message ${nb} ${inboxB.waitedMs < 1000 ? 'within 1 s' : `in ${(inboxB.waitedMs / 1000).toFixed(1)} s`}.` }];
    for (const l of log) items.push({ kind: 'fail', why: 'Form handler log', text: l });
    const dropped = log.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e && e.field);
    if (dropped) {
      for (const f of diff) for (const r of f.removed) if (r.text.includes(`name="${dropped.field}"`)) {
        items.push({ kind: 'fail', why: `Diff line that removed the "${dropped.field}" field`, file: f.path, line: r.line, text: `- ${r.text.trim()}` });
        const id = (/id="([^"]+)"/.exec(r.text) || [])[1];
        const added = f.added.find((a) => id && a.text.includes(`id="${id}"`));
        if (added) items.push({ kind: 'fail', why: 'Replaced by', file: f.path, line: added.line, text: `+ ${added.text.trim()}` });
      }
    }
    return { status: 'fail', items, control, submission };
  }
  const msg = inbox.messages[0];
  const items = [];
  if (msg.to !== pr.site.leads.to) items.push({ kind: 'fail', why: `The lead arrived, addressed to ${msg.to}. sites.yaml routes this site's leads to ${pr.site.leads.to}: the request went to the wrong client.` });
  for (const f of pr.site.leads.required_fields) {
    const want = FORM_FIELDS.find((x) => x.field === f);
    if (!want) items.push({ kind: 'fail', why: `sites.yaml requires a field "${f}" the gate does not know how to fill.` });
    else if (msg.fields?.[f] !== sub.typed[f]) items.push({ kind: 'fail', why: `Field ${f} arrived as "${msg.fields?.[f] ?? '(missing)'}" instead of what was typed.` });
  }
  submission.received = { to: msg.to, waitedMs: inbox.waitedMs, fields: Object.keys(msg.fields || {}) };
  return { status: items.length ? 'fail' : 'pass', items, control, submission };
}

function finish(diff) {
  stopAll();
  const required = MUTANT === 'no-form-check' ? REQUIRED.filter((r) => r !== 'form') : REQUIRED;
  if (results.build && results.build.status !== 'pass') {
    for (const name of required) if (!results[name]) results[name] = { status: results.build.status, items: [{ kind: results.build.status, why: `Not run: the build step did not pass.` }] };
  }
  const d = decide(results, required);
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref?.();
  facts.finished = new Date().toISOString();
  const out = { ...d, ...facts };
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, 'comment.md'), render(out));
  console.log(`${d.label} (${HEAD_SHA})`);
}

const NAMES = { build: 'Build', config: 'sites.yaml is valid', sensitive: 'DNS, env, domain, routing', scope: 'Stays inside its task', visual: 'Screenshots 1440 and 390 px', links: 'Internal links', phone: 'Click-to-call number', form: 'Contact form reaches the inbox' };
const MARK = { pass: 'passed', fail: 'failed', human: 'needs a person', incomplete: 'not verified', info: 'for information' };

function central(iso) {
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' Central';
}

function render(v) {
  const L = ['<!-- pr-gate -->', `## PR gate: ${v.label}`, '', `Commit \`${v.sha}\`, checked ${central(v.finished)}. This verdict covers this commit only; a new push sends the PR back to waiting.`, ''];
  const vis = v.results.visual?.diffs;
  if (vis) L.push(`What a reviewer looking at screenshots would see: ${Object.entries(vis).map(([k, d]) => `${k} ${d.sizeChanged ? 'size changed' : (d.ratio * 100).toFixed(2) + ' %'}`).join(', ')} of pixels changed.`, '');
  L.push('| Check | Result |', '|---|---|');
  for (const [k, r] of Object.entries(v.results)) L.push(`| ${NAMES[k] || k} | ${r.informational && r.status === 'pass' ? 'recorded (screenshots never clear a PR alone)' : MARK[r.status] || r.status} |`);
  const findings = Object.entries(v.results).flatMap(([k, r]) => (r.items || []).map((i) => ({ k, ...i })));
  if (findings.length) {
    L.push('', '### Evidence');
    for (const f of findings) {
      L.push(`- **${NAMES[f.k] || f.k}**: ${f.why}${f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : ''}`);
      if (f.text) L.push('', '  ```', ...f.text.split('\n').map((t) => `  ${t}`), '  ```');
    }
  }
  const s = v.results.form?.submission;
  if (s?.received) L.push('', `Form: test message ${s.nonce} arrived for ${s.received.to} ${s.received.waitedMs < 1000 ? 'within 1 s' : `after ${(s.received.waitedMs / 1000).toFixed(1)} s`} with fields ${s.received.fields.join(', ')}.`);
  L.push('', 'Merging stays a human decision. Changes made directly in a hosting or DNS dashboard never pass through this gate.');
  return L.join('\n') + '\n';
}

main().catch((e) => {
  console.error(e);
  results.build = results.build || { status: 'incomplete', items: [] };
  results.gate = { status: 'incomplete', items: [{ kind: 'incomplete', why: `The gate itself crashed: ${String(e.message).split('\n')[0]}` }] };
  finish([]);
  process.exitCode = 1;
});
