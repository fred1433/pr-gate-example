// Unified diff between two directory trees, parsed into added and removed lines per file.
import { spawnSync } from 'node:child_process';

export const IGNORED = ['node_modules', 'dist', '.astro', '.wrangler', '.git', '.dev.vars', 'site.json', '.gate-state'];

export function parseUnified(text, prRoot) {
  const files = [];
  let cur = null, oldLine = 0, newLine = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('+++ ')) {
      let p = raw.slice(4).split('\t')[0];
      if (prRoot && p.startsWith(prRoot + '/')) p = p.slice(prRoot.length + 1);
      else p = p.replace(/^b\//, '');
      cur = { path: p, added: [], removed: [] };
      files.push(cur);
    } else if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('Only in')) {
      continue;
    } else if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = Number(m[1]); newLine = Number(m[2]);
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

export function computeDiff(baseDir, prDir) {
  const args = ['-ruN', '-U0'];
  for (const x of IGNORED) args.push('-x', x);
  const r = spawnSync('diff', [...args, baseDir, prDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status > 1) throw new Error(`diff failed: ${r.stderr}`);
  return parseUnified(r.stdout, prDir.replace(/\/$/, ''));
}
