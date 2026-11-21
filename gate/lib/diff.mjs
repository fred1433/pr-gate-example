// The diff the gate judges: every path changed between the merge-base and the PR commit,
// read from git. Nothing is excluded by name (invariant I2, docs/invariants.md): a file
// called dist/ or site.json deep in the tree is judged like any other.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} in ${dir}: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  return r.stdout;
}

function unquote(p) {
  if (!p.startsWith('"')) return p;
  try { return JSON.parse(p); } catch { return p.slice(1, -1); }
}

// Added and removed lines per file, from `git diff -U0`.
export function parseUnified(text) {
  const files = new Map();
  let cur = null, oldPath = null, oldLine = 0, newLine = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff ')) { cur = null; oldPath = null; continue; }
    if (raw.startsWith('--- ') && !cur) { const p = unquote(raw.slice(4).split('\t')[0]); oldPath = p === '/dev/null' ? null : p.replace(/^a\//, ''); continue; }
    if (raw.startsWith('+++ ') && !cur) {
      const p = unquote(raw.slice(4).split('\t')[0]);
      const path = p === '/dev/null' ? oldPath : p.replace(/^b\//, '');
      cur = files.get(path) || { path, added: [], removed: [] };
      files.set(path, cur);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) { oldLine = Number(m[1]); newLine = Number(m[2]); }
    } else if (cur && raw.startsWith('+')) {
      cur.added.push({ line: newLine++, text: raw.slice(1) });
    } else if (cur && raw.startsWith('-')) {
      cur.removed.push({ line: oldLine++, text: raw.slice(1) });
    } else if (cur && raw.startsWith(' ')) {
      oldLine++; newLine++;
    }
  }
  return files;
}

// Both directories must be the top of a git checkout that knows both commits (two
// worktrees of one clone, as on GitHub), and the PR checkout must hold nothing that is
// not committed: the gate judges a commit, and builds that commit.
export function revisions(baseDir, prDir) {
  for (const d of [baseDir, prDir]) {
    const top = git(d, ['rev-parse', '--show-toplevel']).trim();
    if (realpathSync(top) !== realpathSync(d)) throw new Error(`${d} is not the top of a git checkout (its checkout starts at ${top})`);
  }
  const baseRev = git(baseDir, ['rev-parse', 'HEAD^{commit}']).trim();
  const prRev = git(prDir, ['rev-parse', 'HEAD^{commit}']).trim();
  const mergeBase = git(prDir, ['merge-base', baseRev, prRev]).trim();
  const dirty = git(prDir, ['status', '--porcelain', '--untracked-files=all']).trim();
  if (dirty) throw new Error(`the PR checkout has changes that are not committed (${dirty.split('\n')[0].trim()}); the gate judges commits`);
  return { baseRev, prRev, mergeBase };
}

export function computeDiff(baseDir, prDir) {
  const { prRev, mergeBase } = revisions(baseDir, prDir);
  const range = [mergeBase, prRev];
  const fields = git(prDir, ['diff', '--no-renames', '--no-ext-diff', '--name-status', '-z', ...range, '--']).split('\0');
  const lines = parseUnified(git(prDir, ['diff', '--no-renames', '--no-ext-diff', '--no-color', '-U0', ...range, '--']));
  const files = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i][0], path = fields[i + 1];
    const l = lines.get(path) || { added: [], removed: [] };
    const content = status === 'D' ? null : git(prDir, ['cat-file', 'blob', `${prRev}:${path}`]);
    files.push({ path, status, added: l.added, removed: l.removed, content });
  }
  return files;
}
