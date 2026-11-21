// Turns a verdict (verdict.json) into the comment posted on the pull request.
// Text that came from the pull request's own code (page headings, log lines, links)
// is passed through clean() first, so it cannot close a code block or fake a heading.

export const VERDICTS = {
  'changes-needed': 'Changes needed',
  'verification-incomplete': 'Verification incomplete',
  'human-decision': 'Human decision required',
  'checks-passed': 'Checks passed: final review required',
};

export const NAMES = {
  build: 'Build', config: 'Site registry is valid', sensitive: 'DNS, env, domain, phone, routing, protected files', scope: 'Stays inside its task',
  visual: 'Screenshots 1440 and 390 px', links: 'Internal links', phone: 'Click-to-call number', form: 'Contact form: test lead recorded', gate: 'Gate', selftest: 'Gate self-test',
};
const MARK = { pass: 'passed', fail: 'failed', human: 'needs a person', incomplete: 'not verified', info: 'for information' };

export function clean(s, max = 200) {
  const t = String(s ?? '').replace(/[`\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function central(iso) {
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' Central';
}

const seconds = (ms) => (ms < 1000 ? 'within 1 s' : `after ${(ms / 1000).toFixed(1)} s`);

export function render(v, { runUrl } = {}) {
  const L = ['<!-- pr-gate -->', `## PR gate: ${v.label}`, '', `Commit \`${v.sha}\`, checked ${central(v.finished)}. This verdict covers this commit only; a new push sends the PR back to waiting.`, ''];
  const vis = v.results.visual?.diffs;
  if (vis) L.push(`What a reviewer looking at screenshots would see: ${Object.entries(vis).map(([k, d]) => `${k} ${d.sizeChanged ? 'page height changed' : `${(d.ratio * 100).toFixed(2)} % of pixels changed`}`).join(', ')}.`, '');
  L.push('| Check | Result |', '|---|---|');
  for (const [k, r] of Object.entries(v.results)) L.push(`| ${NAMES[k] || k} | ${r.informational && r.status === 'pass' ? 'recorded (screenshots never clear a PR alone)' : MARK[r.status] || r.status} |`);
  const findings = Object.entries(v.results).flatMap(([k, r]) => (r.items || []).map((i) => ({ k, ...i })));
  if (findings.length) {
    L.push('', '### Evidence');
    for (const f of findings) {
      L.push(`- **${NAMES[f.k] || f.k}**: ${clean(f.why, 400)}${f.file ? ` (\`${clean(f.file, 120)}${f.line ? `:${f.line}` : ''}\`)` : ''}`);
      if (f.text) L.push('', '  ```', ...String(f.text).split('\n').slice(0, 8).map((t) => `  ${clean(t, 300)}`), '  ```');
    }
  }
  const s = v.results.form?.submission;
  if (s?.recorded) L.push('', `Form: test lead ${s.nonce} recorded in the test lead store for ${clean(s.recorded.to, 80)} ${seconds(s.recorded.waitedMs)}, fields ${s.recorded.fields.map((x) => clean(x, 40)).join(', ')}. The visitor read "${clean(s.heading, 120)}", as on main.`);
  if (v.selftest) L.push('', `Gate self-test on this run: ${v.selftest}.`);
  L.push('', 'This demo records test submissions in a store; it does not test email delivery. Merging stays a human decision. Changes made directly in a hosting or DNS dashboard never pass through this gate.');
  if (runUrl) L.push('', `Run: ${runUrl}`);
  return L.join('\n') + '\n';
}
