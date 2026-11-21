// One test per invariant of docs/invariants.md. gate/mutants.mjs runs this file against
// copies of the gate with one invariant removed each, and requires it to fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { computeDiff, revisions } from '../lib/diff.mjs';
import { sensitiveRule, scopeRule } from '../lib/rules.mjs';
import { fingerprint } from '../lib/fingerprint.mjs';

const GATE = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(GATE);
const registryText = readFileSync(join(ROOT, 'site-registry.yaml'), 'utf8');
const registry = { file: 'site-registry.yaml', text: registryText, cfg: parse(registryText), site: parse(registryText).sites[0] };

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(dir, files) {
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
}
const scratch = (t, name) => { const d = mkdtempSync(join(tmpdir(), `pr-gate-${name}-`)); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

// I1. The reviewer's case: the build the gate tested named the field case_details (built
// under GitHub Actions); the same commit built elsewhere names it message.
test('I1: deploy.sh deploys the tested build and refuses any build whose fingerprint differs', (t) => {
  const deploySh = readFileSync(join(ROOT, 'ops', 'deploy.sh'), 'utf8');
  assert.doesNotMatch(deploySh.replace(/^#.*$/gm, ''), /npm run build|astro build/, 'deploy.sh must never build');

  const root = scratch(t, 'i1');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'ops'), { recursive: true });
  mkdirSync(join(repo, 'gate', 'lib'), { recursive: true });
  mkdirSync(join(repo, 'site'));
  copyFileSync(join(ROOT, 'ops', 'deploy.sh'), join(repo, 'ops', 'deploy.sh'));
  copyFileSync(join(GATE, 'lib', 'fingerprint.mjs'), join(repo, 'gate', 'lib', 'fingerprint.mjs'));
  copyFileSync(join(ROOT, 'site', 'wrangler.toml'), join(repo, 'site', 'wrangler.toml'));
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'tested commit');
  symlinkSync(join(GATE, 'node_modules'), join(repo, 'gate', 'node_modules'));
  const commit = git(repo, 'rev-parse', 'HEAD');

  const evidence = (name, field, verdict = 'checks-passed', fp = null) => {
    const ev = join(root, name);
    write(join(ev, 'tested-build'), {
      'worker/index.js': "export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };\n",
      'dist/contact/index.html': `<form><textarea id="f-details" name="${field}"></textarea></form>\n`,
      'sha.txt': `${commit}\n`,
    });
    writeFileSync(join(ev, 'verdict.json'), JSON.stringify({ verdict, commit, artifact: { sha256: fp ?? fingerprint(join(ev, 'tested-build')) } }));
    return ev;
  };
  const deploy = (ev) => spawnSync('bash', [join(repo, 'ops', 'deploy.sh'), '--dry-run', ev, 'invariant test'], { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: '', WRANGLER_SEND_METRICS: 'false' } });

  const tested = evidence('tested', 'case_details');
  const ok = deploy(tested);
  assert.equal(ok.status, 0, `the tested build is refused: ${ok.stderr}${ok.stdout}`);
  assert.match(ok.stdout, /matches the tested build/);

  const wanted = JSON.parse(readFileSync(join(tested, 'verdict.json'), 'utf8')).artifact.sha256;
  const rebuilt = evidence('rebuilt', 'message', 'checks-passed', wanted);
  const no = deploy(rebuilt);
  assert.equal(no.status, 3, `a build that was not tested is not refused: ${no.stderr}${no.stdout}`);
  assert.match(no.stderr, /not the build that was checked/);

  assert.equal(deploy(evidence('red', 'case_details', 'changes-needed')).status, 4, 'a "Changes needed" build is refused');
  writeFileSync(join(repo, 'site', 'wrangler.toml'), readFileSync(join(repo, 'site', 'wrangler.toml'), 'utf8') + '\n# changed after the check\n');
  git(repo, 'commit', '-q', '-am', 'main moved after the check');
  assert.equal(deploy(tested).status, 4, 'a checkout whose tree is not the tested commit is refused');
});

// I2. The reviewer's case: ops/dist/deploy-hook.sh and a published page under
// site/src/pages/dist/ that reads env.STRIPE_KEY. The old diff skipped both.
test('I2: the diff covers every path changed since the merge-base, at any depth, and only those', (t) => {
  const dir = scratch(t, 'i2');
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  write(repo, {
    'site-registry.yaml': registryText,
    'site/.gitignore': 'node_modules/\ndist/\nsrc/site.json\n',
    'site/src/pages/index.astro': '<h1>Home</h1>\n',
    'ops/deploy.sh': '#!/bin/sh\n',
  });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'main');
  git(repo, 'checkout', '-q', '-b', 'pr');
  write(repo, {
    'ops/dist/deploy-hook.sh': '#!/bin/sh\necho hook\n',
    'site/src/pages/dist/index.astro': "---\nconst env = Astro.locals.runtime?.env ?? {};\nconst on = env.STRIPE_KEY ? 'on' : 'off';\n---\n<p>{on}</p>\n",
    'site/src/site.json': '{"leads":{"to":"someone@else.example"}}\n',
    'node_modules/x/index.js': 'module.exports = 1;\n',
  });
  git(repo, 'add', '-A', '-f');
  git(repo, 'commit', '-q', '-m', 'pr');
  git(repo, 'checkout', '-q', 'main');
  write(repo, { 'site/src/pages/index.astro': '<h1>Home, later on main</h1>\n' });
  git(repo, 'commit', '-q', '-am', 'main moves on');
  git(repo, 'worktree', 'add', '-q', '--detach', join(dir, 'base'), 'main');
  git(repo, 'worktree', 'add', '-q', '--detach', join(dir, 'pr'), 'pr');

  const diff = computeDiff(join(dir, 'base'), join(dir, 'pr'));
  assert.deepEqual(diff.map((f) => f.path).sort(), ['node_modules/x/index.js', 'ops/dist/deploy-hook.sh', 'site/src/pages/dist/index.astro', 'site/src/site.json']);
  const page = diff.find((f) => f.path === 'site/src/pages/dist/index.astro');
  assert.match(page.content, /STRIPE_KEY/, 'the rules read the committed content');

  const s = sensitiveRule({ base: registry, pr: registry, diff });
  assert.equal(s.status, 'fail');
  assert.ok(s.items.some((i) => i.kind === 'fail' && /STRIPE_KEY/.test(i.why) && i.file === 'site/src/pages/dist/index.astro' && i.line === 3));
  assert.ok(s.items.some((i) => i.kind === 'human' && i.file === 'ops/dist/deploy-hook.sh'));
  const scope = scopeRule({ body: 'Files in scope:\n- site/src/pages/index.astro\n', diff });
  assert.equal(scope.status, 'human');
  assert.equal(scope.items.length, 4);

  write(join(dir, 'pr'), { 'site/src/pages/extra.astro': '<p>not committed</p>\n' });
  assert.throws(() => revisions(join(dir, 'base'), join(dir, 'pr')), /not committed/);
});

// I3. Every form the review named, and the ones next to them, as whole files.
test('I3: every read of an environment variable is recognized, whatever its form', () => {
  const judge = (path, content) => sensitiveRule({ base: registry, pr: registry, diff: [{ path, status: 'M', added: [], removed: [], content }] });
  const named = {
    'site/worker/a.js': 'export const a = (env) => env.LEAD_INBOX;',
    'site/worker/b.js': 'export const b = (env) => env?.LEAD_INBOX;',
    'site/worker/c.js': "export const c = (env) => env['LEAD_INBOX'] ?? env?.['X'];",
    'site/worker/d.js': 'export default {\n  async fetch(request, env) {\n    const {\n      FORM_TEST_TOKEN,\n      LEAD_INBOX: inbox = "",\n    } = env;\n    return new Response(inbox + FORM_TEST_TOKEN);\n  },\n};\n',
    'site/worker/e.js': 'function send(request, cfg) { return cfg.LEAD_INBOX; }\nexport default { fetch(request, env) { return send(request, env); } };\n',
    'site/worker/f.js': 'export default { fetch(request, env) { const e = env; return e.LEAD_INBOX; } };',
    'site/worker/g.ts': 'export function g(ctx: { env: Env }) { const { env } = ctx; return (env as Env).LEAD_INBOX!; }',
    'site/worker/h.js': "export const h = (env) => 'LEAD_INBOX' in env;",
    'site/src/pages/i.astro': '---\nconst { runtime: { env: { LEAD_INBOX } } } = Astro.locals;\n---\n<p>{LEAD_INBOX}</p>\n',
    'site/src/pages/j.astro': '---\n---\n<p>{Astro.locals.runtime.env.LEAD_INBOX}</p>\n',
    'site/src/pages/k.astro': '---\nconst x: string = import.meta.env.LEAD_INBOX;\n---\n<p>{x}</p>\n',
    'site/src/pages/l.astro': '<p>hi</p>\n<script>\n  const v = import.meta.env.LEAD_INBOX;\n</script>\n',
    'site/scripts/m.mjs': 'console.log(process.env.LEAD_INBOX);',
  };
  for (const [path, content] of Object.entries(named)) {
    const r = judge(path, content);
    assert.equal(r.status, 'fail', `${path} reads LEAD_INBOX: ${JSON.stringify(r.items)}`);
    assert.ok(r.items.some((i) => /LEAD_INBOX/.test(i.why) && i.line), `${path}: ${JSON.stringify(r.items)}`);
  }
  assert.equal(judge('site/worker/d.js', named['site/worker/d.js']).items.find((i) => /LEAD_INBOX/.test(i.why)).line, 5, 'the line of a multi-line destructuring');

  const unnamed = {
    // the reviewer's line: the field is named after a look at the environment
    'site/src/components/ContactForm.astro': "---\nconst details = Object.keys(process.env).includes('GITHUB_ACTIONS') ? 'case_details' : 'message';\n---\n<textarea name={details}></textarea>\n",
    'site/worker/n.js': 'export const n = (env) => ({ ...env });',
    'site/worker/o.js': 'export const o = (env, k) => env[k];',
    'site/worker/p.js': 'export const p = (env) => { const { FORM_TEST_TOKEN, ...rest } = env; return rest; };',
    'site/worker/q.js': 'import { handle } from "./lib.js";\nexport default { fetch(request, env) { return handle(request, env); } };',
    'site/worker/r.js': 'export const r = () => eval("process.env");',
  };
  for (const [path, content] of Object.entries(unnamed)) {
    const r = judge(path, content);
    assert.equal(r.status, 'human', `${path}: ${JSON.stringify(r.items)}`);
    assert.match(r.items[0].why, /cannot name/, path);
  }
  assert.equal(judge('site/worker/s.js', 'export const s = (env) => {').status, 'human', 'a file that does not parse needs a person');
  assert.equal(judge('site/src/pages/t.mdx', '# hi\n').status, 'human', 'a kind of file the gate does not read needs a person');
  assert.equal(judge('site/worker/u.js', 'export default { fetch(r, env) { return env.ASSETS.fetch(r, env.FORM_TEST_TOKEN, env.INBOX_TOKEN); } };').status, 'pass', 'declared keys and bindings pass');
  assert.equal(judge('site/src/pages/v.astro', '---\nconst base = import.meta.env.BASE_URL;\n---\n<a href={base}>home</a>\n').status, 'pass');
});

// I4. The README states the trust boundary exactly, and a change under .github/ needs a person.
test('I4: the README states that an edited workflow can replace the PR gate status, and the remedy', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  for (const phrase of [
    'a pull request that edits a workflow file can replace the `PR gate` status',
    'GitHub keeps only the latest status for each context',
    'post a green `PR gate` over it, and the ruleset would accept it',
    "It can edit the bot's comment too",
    'Every pull request that touches `.github/` already gets "Human decision required". That does not protect against this case',
    'a GitHub App whose private key lives only in the `pr-gate` environment',
    'It is not installed in this demo.',
  ]) assert.ok(readme.includes(phrase), `README lacks: ${phrase}`);
  assert.ok(!readme.includes('sit beside it'), 'the old, wrong sentence is gone');

  const r = sensitiveRule({ base: registry, pr: registry, diff: [{ path: '.github/workflows/pr-gate-build.yml', status: 'M', added: [{ line: 18, text: '  statuses: write' }], removed: [], content: 'x' }] });
  assert.equal(r.status, 'human');
  assert.match(r.items[0].why, /Touches \.github\/workflows\/pr-gate-build\.yml/);
});
