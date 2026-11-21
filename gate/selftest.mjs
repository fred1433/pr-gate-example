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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i === -1 ? null : argv[i + 1]; };
if (argv.includes('--mutant') && !opt('mutant')) { console.error('usage: --mutant <no-form-check|form-not-run>'); process.exit(2); }
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
  { name: 'fork-no-secrets', fixture: 'good', expect: 'verification-incomplete', env: { FORM_TEST_TOKEN: '', INBOX_TOKEN: '' } },
  { name: 'inbox-unreachable', fixture: 'good', expect: 'verification-incomplete', env: { GATE_INBOX_TOKEN_SERVER_OVERRIDE: 'a-different-token' } },
  { name: 'form-check-not-run', fixture: 'good', expect: 'changes-needed', env: { GATE_MUTANT: 'form-not-run' }, noMutant: true },
].filter((c) => !ONLY || c.name === ONLY);
if (!CASES.length) { console.error(`no case named ${ONLY}`); process.exit(2); }

// Fixtures are patches against the tag fixtures-base, so they keep applying after main moves on.
// The gate code under test is always the current one.
function copyRepo(dest) {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync('sh', ['-c', `git -C "$0" archive fixtures-base sites.yaml CLAUDE.md site | tar -x -C "$1"`, REPO, dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git archive fixtures-base: ${r.stderr}`);
  symlinkSync(join(REPO, 'site', 'node_modules'), join(dest, 'site', 'node_modules'));
}

const rows = [];
for (const c of CASES) {
  const dir = join(WORK, c.name);
  rmSync(dir, { recursive: true, force: true });
  copyRepo(join(dir, 'base'));
  copyRepo(join(dir, 'pr'));
  const p = spawnSync('patch', ['-p1', '-s', '-d', join(dir, 'pr'), '-i', join(HERE, 'fixtures', `${c.fixture}.patch`)], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`patch ${c.fixture}: ${p.stdout}${p.stderr}`);
  const env = { ...process.env, ...(c.env || {}) };
  if (MUTANT && !c.noMutant) env.GATE_MUTANT = MUTANT;
  const t0 = Date.now();
  const r = spawnSync('node', [join(HERE, 'run.mjs'), '--base', join(dir, 'base'), '--pr', join(dir, 'pr'), '--out', join(dir, 'out'), '--pr-body', join(HERE, 'fixtures', `${c.fixture}.body.md`)], { env, encoding: 'utf8' });
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
