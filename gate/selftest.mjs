#!/usr/bin/env node
// Runs the real gate against fixture pull requests and checks each verdict.
//   node gate/selftest.mjs [--only name] [--mutant no-form-check] [--work <dir>]
// With --mutant no-form-check the gate runs without its form check. The self-test
// must then FAIL, because the broken-form fixture slips through: that is how we
// know the form check is doing real work.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { buildSite } from './lib/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i === -1 ? null : argv[i + 1]; };
for (const k of ['mutant', 'only', 'work']) {
  if (argv.includes(`--${k}`) && (!opt(k) || opt(k).startsWith('--'))) { console.error(`usage: node gate/selftest.mjs [--only <case>] [--mutant <no-form-check|form-not-run>] [--work <dir>]\n--${k} needs a value`); process.exit(2); }
}
const MUTANT = opt('mutant') || '';
if (MUTANT && !['no-form-check', 'form-not-run'].includes(MUTANT)) { console.error(`unknown mutant "${MUTANT}"; use no-form-check or form-not-run`); process.exit(2); }
const WORK = resolve(opt('work') || join(tmpdir(), 'pr-gate-selftest'));
const ONLY = opt('only');

const CASES = [
  { name: 'good', fixture: 'good', expect: 'checks-passed' },
  { name: 'broken-form', fixture: 'broken-form', expect: 'changes-needed' },
  { name: 'fix', fixture: 'fix', expect: 'checks-passed' },
  { name: 'dns-change', fixture: 'dns-change', expect: 'human-decision' },
  { name: 'wrong-recipient', fixture: 'wrong-recipient', expect: 'changes-needed' },
  { name: 'tel-mismatch', fixture: 'tel-mismatch', expect: 'changes-needed' },
  { name: 'sticky-bar', fixture: 'sticky-bar', expect: 'changes-needed' },
  { name: 'text-mentions-dns', fixture: 'text-mentions-dns', expect: 'checks-passed' },
  { name: 'env-key-code-only', fixture: 'env-key-code-only', expect: 'changes-needed' },
  // Four pull requests an outside reviewer wrote to get past the gate (21 Nov):
  { name: 'thanks-page-deleted', fixture: 'thanks-page-deleted', expect: 'changes-needed' },
  { name: 'stored-but-told-not-sent', fixture: 'stored-but-told-not-sent', expect: 'changes-needed' },
  { name: 'copy-to-other-client', fixture: 'copy-to-other-client', expect: 'changes-needed' },
  { name: 'registry-phone-digit', fixture: 'registry-phone-digit', expect: 'human-decision' },
  // and the build script that tried to rewrite the verdict: on GitHub it runs in a job
  // that never sees the verdict; here it shows that build files need a person.
  { name: 'build-script-change', fixture: 'build-script-change', expect: 'human-decision' },
  { name: 'fork-no-tokens', fixture: 'good', expect: 'verification-incomplete', env: { GATE_TEST_TOKENS: 'off' } },
  { name: 'store-unreadable', fixture: 'good', expect: 'verification-incomplete', env: { GATE_STORE_NAMESPACE: 'a-store-that-does-not-exist' } },
  { name: 'form-check-not-run', fixture: 'good', expect: 'changes-needed', env: { GATE_MUTANT: 'form-not-run' }, noMutant: true },
].filter((c) => !ONLY || c.name === ONLY);
if (!CASES.length) { console.error(`no case named ${ONLY}`); process.exit(2); }

// Fixtures are patches against the tag fixtures-base, so they keep applying after main moves on.
// The gate code under test is always the current one.
function copyRepo(dest) {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync('sh', ['-c', `git -C "$0" archive fixtures-base site-registry.yaml CLAUDE.md site | tar -x -C "$1"`, REPO, dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git archive fixtures-base: ${r.stderr}`);
  symlinkSync(join(REPO, 'site', 'node_modules'), join(dest, 'site', 'node_modules'));
}

// main is built once (it is the same for every case); each PR is built in its own case.
const baseSrc = join(WORK, '_main');
rmSync(baseSrc, { recursive: true, force: true });
copyRepo(baseSrc);
const baseBuilt = buildSite(baseSrc, join(WORK, '_main-built'), join(WORK, '_main-build.log'));
if (!baseBuilt.ok) { console.error(`main does not build:\n${baseBuilt.tail}`); process.exit(1); }

const rows = [];
for (const c of CASES) {
  const dir = join(WORK, c.name);
  rmSync(dir, { recursive: true, force: true });
  copyRepo(join(dir, 'base'));
  copyRepo(join(dir, 'pr'));
  const p = spawnSync('patch', ['-p1', '-s', '-d', join(dir, 'pr'), '-i', join(HERE, 'fixtures', `${c.fixture}.patch`)], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`patch ${c.fixture}: ${p.stdout}${p.stderr}`);
  const env = { ...process.env, ...(c.env || {}) };
  delete env.GATE_TEST_TOKENS; delete env.GATE_STORE_NAMESPACE;
  Object.assign(env, c.env || {});
  if (MUTANT && !c.noMutant) env.GATE_MUTANT = MUTANT;
  const t0 = Date.now();
  const r = spawnSync('node', [join(HERE, 'run.mjs'), '--base-built', join(WORK, '_main-built'), '--base', join(dir, 'base'), '--pr', join(dir, 'pr'), '--out', join(dir, 'out'), '--pr-body', join(HERE, 'fixtures', `${c.fixture}.body.md`)], { env, encoding: 'utf8' });
  const vfile = join(dir, 'out', 'verdict.json');
  const got = existsSync(vfile) ? JSON.parse(readFileSync(vfile, 'utf8')).verdict : `crash: ${(r.stderr || '').split('\n')[0]}`;
  const ok = got === c.expect;
  rows.push({ name: c.name, expect: c.expect, got, ok, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(20)} expected ${c.expect.padEnd(24)} got ${got} (${rows.at(-1).seconds} s)`);
}
const bad = rows.filter((r) => !r.ok);
writeFileSync(join(WORK, `selftest${MUTANT ? '-' + MUTANT : ''}.json`), JSON.stringify({ mutant: MUTANT || null, at: new Date().toISOString(), rows }, null, 2));
if (MUTANT) console.log(bad.length ? `\nMutant "${MUTANT}" detected: ${bad.length} fixture(s) got the wrong verdict.` : `\nMutant "${MUTANT}" NOT detected: every fixture still got its expected verdict.`);
else console.log(bad.length ? `\n${bad.length} case(s) failed.` : `\nAll ${rows.length} cases got their expected verdict.`);
process.exit(bad.length ? 1 : 0);
