// Fixed rules over the structured diff. No model reads the diff: every finding
// comes from comparing parsed site registries and the changed lines.
import { findLine } from './sites.mjs';
import { VERDICTS } from './render.mjs';
import { envReads, CODE_FILE } from './envreads.mjs';
import { allowlistReasons } from './allowlist.mjs';
export { VERDICTS };

// Files a pull request from the agent never changes without a person deciding:
// the gate and its workflows, the agent's own rules, hosting config, and the build
// (scripts and dependencies run at build time).
export const PROTECTED = [
  { re: /^\.github\//, what: 'the workflows that run the gate' },
  { re: /^gate\//, what: 'the gate itself' },
  { re: /^ops\/(?!requests\/)/, what: 'the deploy and rollback scripts' },
  { re: /^CLAUDE\.md$/, what: "the agent's rules" },
  { re: /^site\/wrangler\.toml$/, what: 'the hosting config' },
  { re: /^site\/package(-lock)?\.json$/, what: 'the build scripts and dependencies' },
  { re: /^site\/scripts\//, what: 'the build scripts' },
  { re: /^site\/astro\.config\.mjs$/, what: 'the build config' },
];
const STANDARD_ENV = new Set(['BASE_URL', 'MODE', 'PROD', 'DEV', 'SITE', 'SSR', 'ASSETS', 'INBOX']);

const recKey = (r) => `${r.type} ${r.name} ${r.value}`;

export function sensitiveRule({ base, pr, diff }) {
  const items = [];
  const human = (why, file, line, text) => items.push({ kind: 'human', why, file, line, text });
  const fail = (why, file, line, text) => items.push({ kind: 'fail', why, file, line, text });
  const b = base.site || {}, p = pr.site || {};
  const bf = `${base.file} on main`, pf = pr.file;

  const before = new Set((b.dns || []).map(recKey)), after = new Set((p.dns || []).map(recKey));
  for (const r of (b.dns || [])) if (!after.has(recKey(r))) human(`DNS record removed: ${recKey(r)}`, bf, findLine(base.text, r.value), `- value: "${r.value}"`);
  for (const r of (p.dns || [])) if (!before.has(recKey(r))) human(`DNS record added: ${recKey(r)}`, pf, findLine(pr.text, r.value), `+ value: "${r.value}"`);

  const envB = new Set(b.env || []), envP = new Set(p.env || []);
  for (const k of envB) if (!envP.has(k)) human(`Environment variable removed from the registry: ${k}`, bf, findLine(base.text, k), `- ${k}`);
  for (const k of envP) if (!envB.has(k)) human(`Environment variable added to the registry: ${k}`, pf, findLine(pr.text, k), `+ ${k}`);
  if (b.domain !== p.domain) human(`Domain changed from ${b.domain} to ${p.domain}`, pf, findLine(pr.text, 'domain:'), `+ domain: ${p.domain}`);
  if (b.phone?.e164 !== p.phone?.e164) human(`Office phone number changed from ${b.phone?.e164} to ${p.phone?.e164}`, pf, findLine(pr.text, 'e164:'), `+ e164: "${p.phone?.e164}"`);
  else if (b.phone?.display !== p.phone?.display) human(`Displayed office phone changed from "${b.phone?.display}" to "${p.phone?.display}"`, pf, findLine(pr.text, 'display:'), `+ display: "${p.phone?.display}"`);
  if (b.leads?.to !== p.leads?.to) human(`Lead recipient changed from ${b.leads?.to} to ${p.leads?.to}`, pf, findLine(pr.text, 'to:'), `+ to: ${p.leads?.to}`);
  if (JSON.stringify(b.leads?.required_fields) !== JSON.stringify(p.leads?.required_fields)) human('Required form fields changed in the registry', pf, findLine(pr.text, 'required_fields'), null);

  for (const f of diff) {
    const hit = PROTECTED.find((x) => x.re.test(f.path));
    if (hit) human(`Touches ${f.path}: ${hit.what}. The agent does not change these without a person.`, f.path, null, null);
  }

  // Environment reads: secondary information since I3 became an allowlist. Each changed
  // code file under site/ is parsed whole, as committed; a key the registry does not
  // declare is still "Changes needed". f.content is null for a deleted file; unit tests
  // may give only added lines. A link's content is its target, not code: skipped.
  for (const f of diff) {
    if (!f.path.startsWith('site/') || f.content === null || f.newMode === '120000' || !CODE_FILE.test(f.path)) continue;
    const text = f.content ?? f.added.map((a) => a.text).join('\n');
    const r = envReads(f.path, text);
    const lines = text.split('\n');
    const show = (line) => (line ? `${f.added.some((a) => a.line === line) ? '+ ' : ''}${lines[line - 1].trim()}` : null);
    if (r.error) { human(`${f.path} could not be parsed (${r.error}), so its environment reads are unknown.`, f.path, null, null); continue; }
    const seen = new Set();
    for (const k of [...r.keys].sort((x, y) => (x.line ?? 0) - (y.line ?? 0))) {
      if (STANDARD_ENV.has(k.key) || envP.has(k.key) || seen.has(k.key)) continue;
      seen.add(k.key);
      fail(`Code reads ${k.key}, which the site registry does not declare. A key renamed in code only breaks the deployed site.`, f.path, k.line, show(k.line));
    }
    for (const d of r.dynamic) human(`Code reads the environment in a way the gate cannot name: ${d.what}. Code that inspects its environment can behave one way under the check and another once deployed.`, f.path, d.line, show(d.line));
  }

  // I3, the allowlist: only markup, style and content under site/ pass on their own.
  // Whatever else changed needs a person, with the reason (docs/invariants.md).
  for (const f of diff) {
    if (PROTECTED.some((x) => x.re.test(f.path))) continue; // already said above
    for (const r of allowlistReasons(f)) human(r.why, f.path, r.line ?? null, r.text ? `${f.added.some((a) => a.text.trim() === r.text) ? '+ ' : ''}${r.text}` : null);
  }
  const status = items.some((i) => i.kind === 'fail') ? 'fail' : items.length ? 'human' : 'pass';
  return { status, items };
}

export function parseScope(body) {
  const lines = (body || '').split('\n');
  const i = lines.findIndex((l) => /^\s*files in scope\s*:/i.test(l));
  if (i === -1) return null;
  const out = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^\s*[-*]\s+`?([^`\s]+)`?/.exec(l);
    if (m) out.push(m[1].replace(/^\.\//, '')); else if (l.trim()) break;
  }
  return out;
}

export function scopeRule({ body, diff }) {
  const scope = parseScope(body);
  if (!scope) return { status: 'human', items: [{ kind: 'human', why: 'The PR description declares no "Files in scope" list, so the change cannot be held to its task.' }] };
  const items = diff.filter((f) => !scope.includes(f.path)).map((f) => ({ kind: 'human', why: `Changed outside the declared scope: ${f.path}`, file: f.path }));
  return { status: items.length ? 'human' : 'pass', items, scope };
}

export function phoneRule({ tels, site }) {
  const expected = site.phone.e164.replace(/\D/g, '').slice(-10);
  const items = [];
  for (const t of tels) {
    const href = t.href.replace(/\D/g, '').slice(-10);
    const shown = t.text.replace(/\D/g, '');
    if (href !== expected) items.push({ kind: 'fail', why: `Link on ${t.page} dials ${t.href} but the site registry says ${site.phone.e164} (text shown: "${t.text.trim()}")` });
    else if (shown.length >= 10 && shown.slice(-10) !== expected) items.push({ kind: 'fail', why: `Text on ${t.page} shows "${t.text.trim()}" but the number in the site registry is ${site.phone.display}` });
  }
  if (tels.length === 0) items.push({ kind: 'fail', why: 'No click-to-call link found on any page.' });
  return { status: items.length ? 'fail' : 'pass', items, checked: tels.length };
}

export const REQUIRED = ['build', 'config', 'sensitive', 'scope', 'visual', 'links', 'phone', 'form'];

export function decide(results, required = REQUIRED) {
  const all = { ...results };
  for (const name of required) {
    if (!all[name]) all[name] = { status: 'fail', items: [{ kind: 'fail', why: `The ${name} check did not run. A check that did not run counts as a failure, never as a pass.` }] };
  }
  const statuses = Object.values(all).map((r) => r.status);
  const verdict = statuses.includes('fail') ? 'changes-needed'
    : statuses.includes('incomplete') ? 'verification-incomplete'
    : statuses.includes('human') ? 'human-decision'
    : 'checks-passed';
  return { verdict, label: VERDICTS[verdict], results: all };
}
