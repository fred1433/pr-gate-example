#!/usr/bin/env node
// Runs the real gate against fixture pull requests and checks each verdict.
//   node gate/selftest.mjs [--only name] [--mutant no-form-check] [--work <dir>]
// With --mutant no-form-check the gate runs without its form check. The self-test
// must then FAIL, because the broken-form fixture slips through: that is how we
// know the form check is doing real work.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, symlinkSync, existsSync, writeFileSync, copyFileSync, appendFileSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { buildSite } from './lib/serve.mjs';
import { collectArtifact } from './lib/fingerprint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// The gate under test: this checkout, or a mutated copy of it (GATE_ROOT, set by gate/mutants.mjs).
const ROOT = resolve(process.env.GATE_ROOT || REPO);
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
  // Two more from the second review (21 Nov), one per invariant they broke (docs/invariants.md):
  // I1 and I3: the form field is named after a look at the environment. Built as on GitHub
  // (GITHUB_ACTIONS set), every runtime check passes; only the environment rule stops it,
  // and deploy.sh must refuse the same commit rebuilt anywhere else.
  { name: 'env-sniff', fixture: 'env-sniff', expect: 'human-decision', env: { GITHUB_ACTIONS: 'true' }, deployCheck: true },
  // I2: a published page and a deploy hook, both under folders called dist.
  { name: 'dist-hidden', fixture: 'dist-hidden', expect: 'changes-needed' },
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

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};

// One git repository per case, as on GitHub: commit 1 is fixtures-base (main), commit 2 the
// fixture applied and committed whole, ignored names included (git add -f). base/ is a
// worktree of commit 1, pr/ the checkout of commit 2. The gate takes its diff from git.
function caseRepo(dir, fixture) {
  const pr = join(dir, 'pr'), base = join(dir, 'base');
  mkdirSync(pr, { recursive: true });
  const r = spawnSync('sh', ['-c', `git -C "$0" archive fixtures-base site-registry.yaml CLAUDE.md site | tar -x -C "$1"`, REPO, pr], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git archive fixtures-base: ${r.stderr}`);
  git(pr, 'init', '-q');
  git(pr, 'add', '-A', '-f');
  git(pr, 'commit', '-q', '-m', 'main (fixtures-base)');
  const p = spawnSync('patch', ['-p1', '-s', '-d', pr, '-i', join(HERE, 'fixtures', `${fixture}.patch`)], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`patch ${fixture}: ${p.stdout}${p.stderr}`);
  git(pr, 'add', '-A', '-f');
  git(pr, 'commit', '-q', '--allow-empty', '-m', `fixture ${fixture}`);
  appendFileSync(join(pr, '.git', 'info', 'exclude'), 'node_modules\n');
  git(pr, 'worktree', 'add', '-q', '--detach', base, 'HEAD~1');
  for (const d of [pr, base]) symlinkSync(join(REPO, 'site', 'node_modules'), join(d, 'site', 'node_modules'));
  return git(pr, 'rev-parse', 'HEAD');
}

// I1: the tested build is accepted by deploy.sh (dry run); the same commit rebuilt outside
// GitHub Actions, as the old deploy.sh rebuilt it, is refused for its fingerprint.
function deployCheck(dir, commit) {
  const pr = join(dir, 'pr'), tested = join(dir, 'out');
  const rebuilt = join(dir, 'rebuilt');
  const saved = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  const b = buildSite(pr, join(dir, 'rebuilt-raw'), join(dir, 'rebuilt-build.log'));
  if (saved !== undefined) process.env.GITHUB_ACTIONS = saved;
  if (!b.ok) return `the rebuild failed: ${b.tail}`;
  const c = collectArtifact(join(dir, 'rebuilt-raw'), join(rebuilt, 'tested-build'), commit);
  if (!c.ok) return c.why;
  copyFileSync(join(tested, 'verdict.json'), join(rebuilt, 'verdict.json'));
  const field = (d) => (/name="(case_details|message)"/.exec(readFileSync(join(d, 'tested-build', 'dist', 'contact', 'index.html'), 'utf8')) || [])[1];
  // deploy.sh of the gate under test, run from the case's repository (it compares trees there)
  mkdirSync(join(pr, 'ops'), { recursive: true });
  mkdirSync(join(pr, 'gate', 'lib'), { recursive: true });
  copyFileSync(join(ROOT, 'ops', 'deploy.sh'), join(pr, 'ops', 'deploy.sh'));
  copyFileSync(join(ROOT, 'gate', 'lib', 'fingerprint.mjs'), join(pr, 'gate', 'lib', 'fingerprint.mjs'));
  if (!existsSync(join(pr, 'gate', 'node_modules'))) symlinkSync(join(REPO, 'gate', 'node_modules'), join(pr, 'gate', 'node_modules'));
  const run = (ev) => spawnSync('bash', [join(pr, 'ops', 'deploy.sh'), '--dry-run', ev, 'selftest'], { encoding: 'utf8' });
  const a = run(tested), r = run(rebuilt);
  const facts = `tested build has name="${field(tested)}", rebuilt has name="${field(rebuilt)}"; deploy.sh: tested exit ${a.status}, rebuilt exit ${r.status}`;
  if (a.status !== 0) return `deploy.sh refused the tested build (${facts}): ${(a.stderr || a.stdout).trim().split('\n').at(-1)}`;
  if (r.status !== 3) return `deploy.sh did not refuse the rebuilt one (${facts})`;
  return { ok: true, facts };
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
  const commit = caseRepo(dir, c.fixture);
  const env = { ...process.env, ...(c.env || {}) };
  delete env.GATE_TEST_TOKENS; delete env.GATE_STORE_NAMESPACE;
  Object.assign(env, c.env || {});
  if (MUTANT && !c.noMutant) env.GATE_MUTANT = MUTANT;
  const t0 = Date.now();
  const r = spawnSync('node', [join(ROOT, 'gate', 'run.mjs'), '--base-built', join(WORK, '_main-built'), '--base', join(dir, 'base'), '--pr', join(dir, 'pr'), '--out', join(dir, 'out'), '--pr-body', join(HERE, 'fixtures', `${c.fixture}.body.md`)], { env, encoding: 'utf8' });
  const vfile = join(dir, 'out', 'verdict.json');
  const got = existsSync(vfile) ? JSON.parse(readFileSync(vfile, 'utf8')).verdict : `crash: ${(r.stderr || '').split('\n')[0]}`;
  let ok = got === c.expect, note = '';
  if (ok && c.deployCheck) { const d = deployCheck(dir, commit); ok = d.ok === true; note = ok ? `\n     I1: ${d.facts}` : `\n     I1 FAILED: ${d}`; }
  rows.push({ name: c.name, expect: c.expect, got, ok, note: note.trim() || undefined, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(24)} expected ${c.expect.padEnd(24)} got ${got} (${rows.at(-1).seconds} s)${note}`);
}
const bad = rows.filter((r) => !r.ok);
writeFileSync(join(WORK, `selftest${MUTANT ? '-' + MUTANT : ''}.json`), JSON.stringify({ mutant: MUTANT || null, at: new Date().toISOString(), rows }, null, 2));
if (MUTANT) console.log(bad.length ? `\nMutant "${MUTANT}" detected: ${bad.length} fixture(s) got the wrong verdict.` : `\nMutant "${MUTANT}" NOT detected: every fixture still got its expected verdict.`);
else console.log(bad.length ? `\n${bad.length} case(s) failed.` : `\nAll ${rows.length} cases got their expected verdict.`);
process.exit(bad.length ? 1 : 0);
