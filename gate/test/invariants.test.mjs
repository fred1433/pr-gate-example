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

// I3. An allowlist: only markup, style and content under site/ pass on their own.
// One test per category of docs/invariants.md, then the reviewers' forms, then the
// environment reads, which stay as secondary information.
const mainFile = (p) => readFileSync(join(ROOT, p), 'utf8');
const judgeFiles = (files) => sensitiveRule({ base: registry, pr: registry, diff: files.map((f) => ({ status: 'M', added: [], removed: [], ...f })) });
const judge = (path, content, extra = {}) => judgeFiles([{ path, content, status: 'A', ...extra }]);
const edit = (path, from, to) => {
  const before = mainFile(path);
  assert.ok(before.includes(from), `${path} on main lacks: ${from}`);
  return { path, status: 'M', baseContent: before, content: before.replace(from, to) };
};
const needsPerson = (r, re, label) => {
  assert.equal(r.status, 'human', `${label}: ${JSON.stringify(r.items)}`);
  if (re) assert.ok(r.items.some((i) => re.test(i.why)), `${label}: ${JSON.stringify(r.items.map((i) => i.why))}`);
};

test('I3: markup, style and content under site/ pass on their own (the three green pull requests among them)', () => {
  const ok = {
    // PR 1: text in the markup
    'office hours': [edit('site/src/pages/attorneys/index.astro', 'Monday to Friday, 8:30 am to 5:30 pm. Evening calls by appointment.', 'Monday to Friday, 8 am to 6 pm. Saturday 9 am to noon by appointment.')],
    // PR 4: static attributes
    'autocomplete': [edit('site/src/components/ContactForm.astro', '<input id="f-phone" name="phone" type="tel" autocomplete="tel" required>', '<input id="f-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" required>')],
    // PR 8: a link built from a name of the unchanged frontmatter, and a new page whose
    // frontmatter only imports the layout
    'privacy page': [
      edit('site/src/layouts/Base.astro', '<span>Mockingbird &amp; Pike, Austin, Texas. A fictional firm.</span>', '<span>Mockingbird &amp; Pike, Austin, Texas. A fictional firm. <a href={`${base}/privacy/`}>Privacy</a></span>'),
      { path: 'site/src/pages/privacy/index.astro', status: 'A', content: "---\nimport Base from '../../layouts/Base.astro';\n---\n<Base title=\"Privacy\">\n  <h1>Privacy</h1>\n</Base>\n" },
    ],
    'names and members': [edit('site/src/layouts/Base.astro', '<main><slot /></main>', '<main data-title={title} data-tel={site.phone.e164}><slot /></main>')],
    'style': [{ path: 'site/src/styles.css', content: '.foot a { color: #222; }\n' }],
    'markdown': [{ path: 'site/src/pages/faq.md', status: 'A', content: '# FAQ\n\nCall us.\n' }],
    'image': [{ path: 'site/src/assets/logo.png', status: 'A', content: '\x89PNG' }],
    'public file removed': [{ path: 'site/public/old.png', status: 'D', content: null }],
    'links and styles': [{ path: 'site/src/pages/faq.md', status: 'A', content: '# FAQ\n\nSee [contact](/contact/), <https://example.org/> or <a href="https://example.org/">this</a>.\n<p style="color: red">x</p>\n' },
      edit('site/src/styles.css', 'a { color: var(--green); }', 'a { color: var(--green); }\n.hero { background: url(/hero.png); }\n@font-face { font-family: x; src: url("./x.woff2"); }')],
    'literal url': [edit('site/src/layouts/Base.astro', '<main><slot /></main>', '<main><a href={"/contact/"}>x</a><a href="mailto:a@example.org">m</a><slot /></main>')],
    'page removed': [{ path: 'site/src/pages/attorneys/index.astro', status: 'D', content: null, baseContent: mainFile('site/src/pages/attorneys/index.astro') }],
    'operator request': [{ path: 'ops/requests/contact-form/2-note.md', status: 'A', content: '# Note\n' }],
  };
  for (const [label, files] of Object.entries(ok)) {
    const r = judgeFiles(files);
    assert.equal(r.status, 'pass', `${label}: ${JSON.stringify(r.items)}`);
  }
});

test('I3: executable code goes to a person (worker, .js, .mjs, .ts, .cjs, build config, frontmatter, <script>, template code)', () => {
  needsPerson(judge('site/worker/index.js', 'export default { fetch() { return new Response("x"); } };\n', { status: 'M' }), /executable code \(\.js\)/, 'worker');
  for (const ext of ['js', 'mjs', 'ts', 'cjs', 'mts', 'tsx']) needsPerson(judge(`site/src/lib/brand.${ext}`, "export const tagline = 'Texas';\n"), new RegExp(`executable code \\(\\.${ext}\\)`), ext);
  needsPerson(judge('site/astro.config.mjs', 'export default {};\n', { status: 'M' }), /build config/, 'astro config');
  needsPerson(judge('site/tsconfig.json', '{}\n'), /configuration or data/, 'tsconfig');
  needsPerson(judge('site/src/data/hours.yaml', 'open: 8\n'), /configuration or data/, 'yaml');
  // frontmatter: changed, or a new file whose frontmatter is more than default imports of .astro files
  needsPerson(judgeFiles([edit('site/src/pages/attorneys/index.astro', "import Base from '../../layouts/Base.astro';", "import Base from '../../layouts/Base.astro';\nconst year = 2026;")]), /changes its frontmatter/, 'frontmatter');
  for (const [label, fm] of Object.entries({
    'non-.astro import': "import tag from '../lib/brand.mjs';",
    'named import': "import { tag } from '../lib/brand.astro';",
    'bare import': "import Base from 'cloudflare:workers';",
    'import from outside site': "import Base from '../../../../shared/Base.astro';",
    'side-effect import': "import '../lib/brand.astro';",
    'statement': "const x = 1;",
  })) needsPerson(judge('site/src/pages/new.astro', `---\n${fm}\n---\n<p>hi</p>\n`), /changes its frontmatter/, label);
  // <script>: added, changed or removed
  needsPerson(judge('site/src/pages/new.astro', '<p>hi</p>\n<script>\n  console.log(1);\n</script>\n'), /<script>/, 'script added');
  needsPerson(judgeFiles([edit('site/src/pages/attorneys/index.astro', '<h1>Our attorneys</h1>', '<h1>Our attorneys</h1><script is:inline>void 0</script>')]), /<script>/, 'inline script');
  // template expressions: only literals and names of an unchanged frontmatter
  for (const [label, expr] of Object.entries({
    'call': '{f()}', 'method call': '{base.replace("a", "b")}', 'Astro': '{Astro.url.pathname}', 'process': '{process.platform}',
    'import.meta': '{import.meta.env.MODE}', 'operator': '{base + "/x"}', 'conditional': '{title ? "a" : "b"}',
    'computed member': '{site["phone"]}', 'undeclared name': '{STRIPE_KEY}', 'tagged template': '{String.raw`x`}', 'markup in braces': '{title && <b>x</b>}',
    'spread': '<p {...Astro.props}>x</p>', 'call in template literal': '{`${f()}`}',
  })) needsPerson(judgeFiles([edit('site/src/layouts/Base.astro', '<main><slot /></main>', `<main>${expr}<slot /></main>`)]), /template expression that is code/, label);
  for (const [label, attr] of Object.entries({ 'event handler': '<a onclick="go()">x</a>', 'set:html': '<div set:html="<i>x</i>"></div>', 'javascript: URL': '<a href="javascript:go()">x</a>', 'srcdoc': '<iframe srcdoc="<p>x</p>"></iframe>' })) {
    needsPerson(judgeFiles([edit('site/src/layouts/Base.astro', '<main><slot /></main>', `<main>${attr}<slot /></main>`)]), /event handler, set:html, srcdoc/, label);
  }
  needsPerson(judge('site/src/pages/faq.md', '# FAQ\n<script>alert(1)</script>\n'), /holds a <script>/, 'script in markdown');
});

test('I3: a file outside site/ goes to a person, except the operator files under ops/requests/', () => {
  needsPerson(judge('shared/brand.mjs', "export const tagline = '';\n"), /outside site\//, 'shared/');
  needsPerson(judge('README.md', '# x\n', { status: 'M' }), /outside site\//, 'README');
  needsPerson(judge('ops/requests/run.sh', 'echo\n'), /outside site\//, 'a script under ops/requests');
  assert.equal(judge('ops/requests/contact-form/3-reply.md', '# Reply\n').status, 'pass');
});

test('I3: a symbolic link, whatever it points to, and a change of mode go to a person', (t) => {
  const dir = scratch(t, 'i3-links'), wt = join(scratch(t, 'i3-links-base'), 'main');
  write(dir, { 'site/src/styles.css': 'p {}\n', 'site/src/lib/brand.yaml': "export const banner = process.env.HOME ? 'BUILT-WITH-ENV-READ' : 'no';\n", 'site/src/pages/a.astro': '<p>a</p>\n' });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main');
  git(dir, 'checkout', '-q', '-b', 'pr');
  symlinkSync('brand.yaml', join(dir, 'site/src/lib/brand.mjs'));
  symlinkSync('../styles.css', join(dir, 'site/src/lib/theme.css'));
  write(dir, { 'site/src/public.png': 'x' });
  spawnSync('chmod', ['+x', join(dir, 'site/src/styles.css'), join(dir, 'site/src/public.png')]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'pr');
  git(dir, 'worktree', 'add', '-q', '--detach', wt, 'main');
  const diff = computeDiff(wt, dir);
  const by = Object.fromEntries(diff.map((f) => [f.path, f]));
  assert.equal(by['site/src/lib/brand.mjs'].newMode, '120000');
  const r = sensitiveRule({ base: registry, pr: registry, diff });
  assert.equal(r.status, 'human');
  const why = (p) => r.items.filter((i) => i.file === p).map((i) => i.why).join(' | ');
  assert.match(why('site/src/lib/brand.mjs'), /symbolic link to brand\.yaml/);
  assert.match(why('site/src/lib/theme.css'), /symbolic link to \.\.\/styles\.css/, 'a link to a stylesheet is still a link');
  assert.match(why('site/src/styles.css'), /changes mode from 100644 to 100755/);
  assert.match(why('site/src/public.png'), /has mode 100755/);
});

test('I3: an extension the gate does not know goes to a person', () => {
  needsPerson(judge('site/src/data.bin', 'x'), /extension the gate does not know \(\.bin\)/, '.bin');
  needsPerson(judge('site/src/pages/LICENSE', 'x'), /extension the gate does not know \(none\)/, 'no extension');
  needsPerson(judge('site/src/pages/t.mdx', '# hi\n'), /executable code \(\.mdx\)/, '.mdx can hold code');
});

// The fourth review (21 Nov) got "Checks passed" with JavaScript that ran on the page.
// One test per fix; the self-test builds one fixture per fix.
const onMain = (expr) => judgeFiles([edit('site/src/layouts/Base.astro', '<main><slot /></main>', `<main>${expr}<slot /></main>`)]);
test('I3: any file added or modified under site/public/ goes to a person, whatever its extension', () => {
  for (const [path, content] of Object.entries({
    'site/public/feed.xml': '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>\n',
    'site/public/promo.html': '<!doctype html><svg/onload=alert(1)>\n',
    'site/public/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    'site/public/robots.txt': 'User-agent: *\n',
    'site/public/logo.png': '\x89PNG',
  })) {
    needsPerson(judge(path, content), /under site\/public\//, `${path} added`);
    needsPerson(judge(path, content, { status: 'M', baseContent: '' }), /under site\/public\//, `${path} modified`);
  }
});

test('I3: a template expression uses only names of an unchanged frontmatter, never a name the pull request brings', () => {
  // a new page: its import of the layout is allowed, the name it brings is not usable in {}
  needsPerson(judge('site/src/pages/team.astro', "---\nimport Base from '../layouts/Base.astro';\n---\n<Base title=\"Team\"><p>{Base.name}</p></Base>\n"), /template expression that is code/, 'imported name');
  needsPerson(judge('site/src/pages/team.astro', "---\nimport Base from '../layouts/Base.astro';\n---\n<Base title={Base}><p>x</p></Base>\n"), /template expression that is code/, 'imported name as a prop');
  // a frontmatter the PR changes: the frontmatter goes to a person, and so do its names
  const f = edit('site/src/layouts/Base.astro', '<main><slot /></main>', '<main>{ping}<slot /></main>');
  f.content = f.content.replace("const base = ", "const ping = () => 'x';\nconst base = ");
  const r = judgeFiles([f]);
  needsPerson(r, /changes its frontmatter/, 'changed frontmatter');
  assert.ok(r.items.some((i) => /template expression that is code/.test(i.why)), `the new name is not usable: ${JSON.stringify(r.items.map((i) => i.why))}`);
  // names of the unchanged frontmatter (code on main) and member reads of them pass
  assert.equal(onMain('<p data-t={title}>{site.phone.display}</p><a href={`${base}/x/`}>x</a>').status, 'pass');
});

test('I3: a URL attribute or expression with a javascript:, vbscript: or data: URL goes to a person, entities and spaces removed', () => {
  for (const [label, html] of Object.entries({
    'expression': '<a href={"javascript:alert(1)"}>x</a>', 'template': '<a href={`java${""}script:alert(1)`}>x</a>',
    'tab': '<a href="java\tscript:alert(1)">x</a>', 'newline entity': '<a href="java&NewLine;script:alert(1)">x</a>',
    'decimal entity': '<a href="&#106;avascript:alert(1)">x</a>', 'hex entity': '<a href="&#x6A;avascript:alert(1)">x</a>',
    'upper case': '<a href="JaVaScRiPt:alert(1)">x</a>', 'leading space': '<a href=" \u0001javascript:alert(1)">x</a>',
    'vbscript': '<a href="vbscript:msgbox(1)">x</a>', 'data': '<img src="data:image/svg+xml,<svg/onload=alert(1)>">',
    'form action': '<form action="javascript:alert(1)"></form>', 'formaction': '<button formaction={"javascript:alert(1)"}>x</button>',
    'xlink:href': '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>', 'srcset': '<img srcset="/a.png 1x, data:image/png;base64,AA 2x">',
  })) needsPerson(onMain(html), /javascript:, vbscript: or data: URL/, label);
  for (const [label, md] of Object.entries({
    'markdown link': '[b](&#106;avascript:alert(1))', 'escaped colon': '[b](javascript\\:alert(1))', 'reference': '[b]\n\n[b]: javascript:alert(1)',
    'autolink': '<javascript:alert(1)>', 'html in markdown': '<a href="&#106;avascript:alert(1)">b</a>', 'data image': '![i](data:image/png;base64,AAA)',
  })) needsPerson(judge('site/src/pages/faq.md', `# FAQ\n\n${md}\n`), /javascript:, vbscript: or data: URL/, label);
});

test('I3: <script> in any case, <base>, <iframe>, <object>, <embed>, <meta http-equiv> and any on* attribute go to a person', () => {
  needsPerson(onMain('<SCRIPT>alert(1)</SCRIPT>'), /<script>/, 'SCRIPT');
  for (const [label, html] of Object.entries({
    base: '<base href="https://example.org/">', iframe: '<iframe src="/x/"></iframe>', object: '<object data="/x/"></object>',
    embed: '<embed src="/x/">', 'meta http-equiv': '<meta http-equiv="refresh" content="0;url=/x/">',
  })) needsPerson(onMain(html), new RegExp(`<${label}>`), label);
  needsPerson(onMain('<p onClick="x()">x</p>'), /event handler/, 'onClick');
  needsPerson(onMain('<a "x"onerror="alert(1)">x</a>'), null, '"x"onerror in .astro (not parsed)');
  for (const [label, text] of Object.entries({
    '/onload': '<svg/onload=alert(1)>', '"x"onerror': '<img src="/a.png" alt="x"onerror="alert(1)">', 'alt=""/onerror': '<img src="/a.png" alt=""/onerror="alert(1)">',
  })) for (const path of ['site/src/pages/faq.md', 'site/src/pages/promo.html', 'site/src/assets/i.svg']) needsPerson(judge(path, `${text}\n`), /event handler/, `${label} in ${path}`);
  for (const [label, text] of Object.entries({ SCRIPT: '<SCRIPT>alert(1)</SCRIPT>', base: '<base href="https://example.org/">', iframe: '<iframe src="/x/"></iframe>', object: '<object data="/x/"></object>', embed: '<embed src="/x/">', meta: '<meta http-equiv="refresh" content="0">' })) {
    needsPerson(judge('site/src/pages/faq.md', `# FAQ\n\n${text}\n`), null, `${label} in markdown`);
  }
  needsPerson(judge('site/src/assets/feed.xml', '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>\n'), /<script>/, 'xml outside public');
  // a component the frontmatter imports may share a name with an element: <Base> is the layout
  assert.equal(judge('site/src/pages/team.astro', "---\nimport Base from '../layouts/Base.astro';\n---\n<Base title=\"Team\"><p>x</p></Base>\n").status, 'pass');
});

test('I3: a style that loads from another domain (@import, url()) goes to a person', () => {
  for (const [label, css] of Object.entries({
    '@import url()': '@import url("https://example.org/x.css");', '@import string': "@import 'https://example.org/x.css';",
    'url()': '.hero { background: url(https://example.org/a.png); }', 'protocol-relative': '.hero { background: url(//example.org/a.png); }',
    'css escape': '.hero { background: u\\72l(https://example.org/a.png); }', 'font': '@font-face { font-family: x; src: url("https://example.org/x.woff2"); }',
  })) {
    needsPerson(judgeFiles([edit('site/src/styles.css', 'a { color: var(--green); }', `a { color: var(--green); }\n${css}`)]), /another domain/, `styles.css ${label}`);
    needsPerson(onMain(`<style>${css}</style>`), /another domain/, `<style> ${label}`);
  }
  needsPerson(onMain('<p style="background: url(https://example.org/a.png)">x</p>'), /another domain/, 'style attribute');
  needsPerson(onMain('<link rel="stylesheet" href="https://example.org/x.css">'), /another domain/, '<link rel=stylesheet>');
  needsPerson(judge('site/src/pages/faq.md', '# FAQ\n\n<style>@import "https://example.org/x.css";</style>\n'), /another domain/, 'markdown <style>');
});

// The pull requests and forms the second and third reviews used to get past the old I3
// (21 Nov). The self-test builds c1 and c3 whole (fixtures reviewer-c1, reviewer-c3).
test('I3: every form the reviewers used needs a person', () => {
  const forms = {
    'site/worker/index.js': 'export default {\n  async fetch(request, bindings) {\n    return new Response(bindings.STRIPE_SECRET_KEY);\n  },\n};\n',
    'site/worker/b.js': "import { env as cf } from 'cloudflare:workers';\nexport const k = cf.STRIPE_KEY;\n",
    'site/src/lib/c.mjs': "import { env as e } from 'node:process';\nexport const k = e.STRIPE_KEY;\n",
    'site/src/lib/d.mjs': "export const v = process['en' + 'v'].STRIPE_KEY;\n",
    'site/src/lib/e.mjs': "export const v = Reflect.get(process, 'env').STRIPE_KEY;\n",
    'site/worker/f.js': 'export default { async fetch() { return new Response(arguments[1].STRIPE_KEY); } };\n',
    'site/worker/g.js': 'export default { async fetch(...a) { return new Response(a[1].STRIPE_KEY); } };\n',
  };
  for (const [path, content] of Object.entries(forms)) needsPerson(judge(path, content, { status: 'M' }), /executable code/, path);
  needsPerson(judge('site/src/pages/x.astro', "---\nconst v = process['en'+'v'].STRIPE_KEY;\n---\n<p>{v ? 'a' : 'b'}</p>\n"), /frontmatter/, 'astro frontmatter');
  needsPerson(judge('site/src/pages/x.astro', "<p>{process['en' + 'v'].STRIPE_KEY}</p>\n"), /template expression that is code/, 'astro template');
  needsPerson(judge('site/src/lib/brand.mjs', 'brand.yaml', { newMode: '120000' }), /symbolic link/, 'link to a .yaml');
});

// Secondary: the environment reads are still named, so a key renamed in code only is
// "Changes needed" with its line. The verdict "Checks passed" no longer depends on them.
test('I3 (secondary): environment reads are still named, in the forms listed in docs/invariants.md', () => {
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
  };
  for (const [path, content] of Object.entries(named)) {
    const r = judge(path, content);
    assert.equal(r.status, 'fail', `${path} reads LEAD_INBOX: ${JSON.stringify(r.items)}`);
    assert.ok(r.items.some((i) => i.kind === 'fail' && /LEAD_INBOX/.test(i.why) && i.line), `${path}: ${JSON.stringify(r.items)}`);
  }
  assert.equal(judge('site/worker/d.js', named['site/worker/d.js']).items.find((i) => /LEAD_INBOX/.test(i.why)).line, 5, 'the line of a multi-line destructuring');
  const unnamed = {
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
    assert.ok(r.items.some((i) => /cannot name/.test(i.why)), path);
  }
  const declared = judge('site/worker/u.js', 'export default { fetch(r, env) { return env.ASSETS.fetch(r, env.FORM_TEST_TOKEN, env.INBOX_TOKEN); } };');
  assert.ok(!declared.items.some((i) => i.kind === 'fail' || /environment/.test(i.why)), `declared keys and bindings raise nothing about the environment: ${JSON.stringify(declared.items)}`);
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
