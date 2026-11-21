// Fixed rules over the structured diff. No model reads the diff: every finding
// comes from comparing parsed sites.yaml files and the changed lines.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findLine } from './sites.mjs';

export const PROTECTED = [/^\.github\//, /^gate\//, /^ops\//, /^site\/wrangler\.toml$/];
const STANDARD_ENV = new Set(['BASE_URL', 'MODE', 'PROD', 'DEV', 'SITE', 'SSR', 'ASSETS', 'INBOX']);
const ENV_USE = /\b(?:import\.meta\.env|env)\.([A-Z][A-Z0-9_]*)\b/g;

const recKey = (r) => `${r.type} ${r.name} ${r.value}`;

export function sensitiveRule({ base, pr, diff }) {
  const items = [];
  const human = (why, file, line, text) => items.push({ kind: 'human', why, file, line, text });
  const fail = (why, file, line, text) => items.push({ kind: 'fail', why, file, line, text });
  const b = base.site || {}, p = pr.site || {};

  const before = new Set((b.dns || []).map(recKey)), after = new Set((p.dns || []).map(recKey));
  for (const r of (b.dns || [])) if (!after.has(recKey(r))) human(`DNS record removed: ${recKey(r)}`, 'sites.yaml on main', findLine(base.text, r.value), `- value: "${r.value}"`);
  for (const r of (p.dns || [])) if (!before.has(recKey(r))) human(`DNS record added: ${recKey(r)}`, 'sites.yaml', findLine(pr.text, r.value), `+ value: "${r.value}"`);

  const envB = new Set(b.env || []), envP = new Set(p.env || []);
  for (const k of envB) if (!envP.has(k)) human(`Environment variable removed from the registry: ${k}`, 'sites.yaml on main', findLine(base.text, k), `- ${k}`);
  for (const k of envP) if (!envB.has(k)) human(`Environment variable added to the registry: ${k}`, 'sites.yaml', findLine(pr.text, k), `+ ${k}`);
  if (b.domain !== p.domain) human(`Domain changed from ${b.domain} to ${p.domain}`, 'sites.yaml', findLine(pr.text, 'domain:'), `+ domain: ${p.domain}`);
  if (b.leads?.to !== p.leads?.to) human(`Lead recipient changed from ${b.leads?.to} to ${p.leads?.to}`, 'sites.yaml', findLine(pr.text, 'to:'), `+ to: ${p.leads?.to}`);
  if (JSON.stringify(b.leads?.required_fields) !== JSON.stringify(p.leads?.required_fields)) human('Required form fields changed in sites.yaml', 'sites.yaml', findLine(pr.text, 'required_fields'), null);

  for (const f of diff) if (PROTECTED.some((re) => re.test(f.path))) human(`Touches ${f.path}, which the agent must not change`, f.path, null, null);

  for (const f of diff) {
    if (!f.path.startsWith('site/') || f.path.endsWith('.yaml')) continue;
    for (const a of f.added) {
      for (const m of a.text.matchAll(ENV_USE)) {
        const key = m[1];
        if (!STANDARD_ENV.has(key) && !envP.has(key)) fail(`Code reads ${key}, which sites.yaml does not declare. A key renamed in code only breaks the deployed site.`, f.path, a.line, `+ ${a.text.trim()}`);
      }
    }
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
    if (m) out.push(m[1]); else if (l.trim()) break;
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
    if (href !== expected) items.push({ kind: 'fail', why: `Link on ${t.page} dials ${t.href} but sites.yaml says ${site.phone.e164} (text shown: "${t.text.trim()}")` });
    else if (shown.length >= 10 && shown.slice(-10) !== expected) items.push({ kind: 'fail', why: `Text on ${t.page} shows "${t.text.trim()}" but the number in sites.yaml is ${site.phone.display}` });
  }
  if (tels.length === 0) items.push({ kind: 'fail', why: 'No click-to-call link found on any page.' });
  return { status: items.length ? 'fail' : 'pass', items, checked: tels.length };
}

export const REQUIRED = ['build', 'config', 'sensitive', 'scope', 'visual', 'links', 'phone', 'form'];

export const VERDICTS = {
  'changes-needed': 'Changes needed',
  'verification-incomplete': 'Verification incomplete',
  'human-decision': 'Human decision required',
  'checks-passed': 'Checks passed: final review required',
};

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

export function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
export { join };
