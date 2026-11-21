// The fingerprint of a build (invariant I1, docs/invariants.md): SHA-256 over the sorted
// list of "path, SHA-256 of content" of every file. The gate records it for the build it
// tested; ops/deploy.sh recomputes it and refuses to deploy anything else.
//   node gate/lib/fingerprint.mjs <dir>   prints the fingerprint
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, mkdirSync, cpSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function listFiles(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
    else throw new Error(`${rel} is not a regular file`);
  }
  return out.sort();
}

export function fingerprint(dir) {
  const h = createHash('sha256');
  for (const rel of listFiles(dir)) h.update(`${rel}\0${sha256(readFileSync(join(dir, rel)))}\n`);
  return h.digest('hex');
}

// What gets tested, kept and deployed: worker/index.js, the regular files of dist/, and
// the commit it was built from. Symlinks are dropped.
export function collectArtifact(builtDir, outDir, commit) {
  const entry = join(builtDir, 'worker', 'index.js');
  if (!existsSync(entry) || !lstatSync(entry).isFile()) return { ok: false, why: 'The build has no worker/index.js.' };
  if (!existsSync(join(builtDir, 'dist')) || !lstatSync(join(builtDir, 'dist')).isDirectory()) return { ok: false, why: 'The build has no dist/ folder.' };
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'worker'), { recursive: true });
  cpSync(entry, join(outDir, 'worker', 'index.js'));
  cpSync(join(builtDir, 'dist'), join(outDir, 'dist'), { recursive: true, filter: (src) => { const st = lstatSync(src); return st.isDirectory() || st.isFile(); } });
  writeFileSync(join(outDir, 'sha.txt'), `${commit}\n`);
  return { ok: true, sha256: fingerprint(outDir) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node gate/lib/fingerprint.mjs <dir>'); process.exit(2); }
  try { console.log(fingerprint(dir)); } catch (e) { console.error(e.message); process.exit(1); }
}
