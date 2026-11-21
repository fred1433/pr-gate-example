#!/usr/bin/env node
// Mutation test of the invariants (docs/invariants.md). For each mutant, a copy of the gate
// is made with one invariant removed, and gate/test/invariants.test.mjs runs against it:
// the mutant is caught ("killed") when the test of that invariant fails. The unmutated
// copy runs first and must pass, or the result means nothing.
//   node gate/mutants.mjs            exit 0 only if the control passes and every mutant is killed
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

export const MUTANTS = [
  { name: 'deploy-skips-fingerprint', invariant: 'I1', file: 'ops/deploy.sh',
    from: 'if [ "$got" != "$want" ]; then', to: 'if false; then' },
  { name: 'diff-skips-dist', invariant: 'I2', file: 'gate/lib/diff.mjs',
    from: '    files.push({ path, status,', to: "    if (!path.split('/').includes('dist')) files.push({ path, status," },
  { name: 'env-no-destructuring', invariant: 'I3', file: 'gate/lib/envreads.mjs',
    from: "case 'VariableDeclarator': if (field === 'init') bind(p.id, p); break;", to: "case 'VariableDeclarator': break;" },
];

function copyGate(dest) {
  cpSync(join(REPO, 'gate'), join(dest, 'gate'), { recursive: true, filter: (src) => !src.startsWith(join(REPO, 'gate', 'node_modules')) });
  symlinkSync(join(REPO, 'gate', 'node_modules'), join(dest, 'gate', 'node_modules'));
  cpSync(join(REPO, 'ops'), join(dest, 'ops'), { recursive: true });
  mkdirSync(join(dest, 'site'));
  for (const f of ['site-registry.yaml', 'README.md', 'site/wrangler.toml']) cpSync(join(REPO, f), join(dest, f));
}

function run(m) {
  const dir = mkdtempSync(join(tmpdir(), `pr-gate-mutant-${m ? m.name : 'control'}-`));
  try {
    copyGate(dir);
    if (m) {
      const p = join(dir, m.file), text = readFileSync(p, 'utf8');
      const n = text.split(m.from).length - 1;
      if (n !== 1) throw new Error(`mutant ${m.name}: expected the text to mutate once in ${m.file}, found it ${n} times`);
      writeFileSync(p, text.replace(m.from, m.to));
    }
    const r = spawnSync('node', ['--test', '--test-reporter=tap', 'test/invariants.test.mjs'], { cwd: join(dir, 'gate'), encoding: 'utf8', timeout: 300000 });
    const failed = [...(r.stdout || '').matchAll(/^not ok \d+ - (I\d)\b/gm)].map((x) => x[1]);
    return { status: r.status, failed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.length > 2) { console.error('usage: node gate/mutants.mjs   (no arguments)'); process.exit(2); }

const control = run(null);
console.log(`${control.status === 0 ? 'ok    ' : 'FAIL  '} control (no mutation): invariant tests ${control.status === 0 ? 'pass' : `fail (${control.failed.join(', ')})`}`);
let bad = control.status !== 0;
for (const m of MUTANTS) {
  const r = run(m);
  const killed = r.failed.includes(m.invariant);
  bad ||= !killed;
  console.log(`${killed ? 'killed' : 'MISSED'} ${m.name.padEnd(26)} (${m.invariant}, ${m.file}): ${killed ? `the ${m.invariant} test fails` : 'every invariant test still passes'}${r.failed.length ? `; failing: ${r.failed.join(', ')}` : ''}`);
}
console.log(bad ? '\nThe mutation test failed.' : `\nControl passes; all ${MUTANTS.length} mutants killed.`);
process.exit(bad ? 1 : 0);
