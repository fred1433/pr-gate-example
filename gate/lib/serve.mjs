// Building a site and serving a build in workerd.
//
// On GitHub the pull request is built in its own job (untrusted, no secrets, read-only
// token) and only its output reaches the gate: dist/ and worker/index.js. The gate
// serves that output with its own pinned wrangler, its own config (bindings come from
// here, not from the PR), no bundling step, and a fresh local store. The PR's code then
// runs inside workerd, which has no access to the disk. The store is read back by the
// gate through wrangler's local KV commands, never through an endpoint of the PR's code.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, existsSync, lstatSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(GATE, 'node_modules', '.bin', 'wrangler');
export const STORE_ID = 'gate-test-store';
const COMPAT_DATE = '2026-09-01';

export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/TOKEN|SECRET|KEY|PASSWORD/i.test(k)) delete env[k];
  env.WRANGLER_SEND_METRICS = 'false';
  return env;
}

// Local mode only (self-test, a run on your machine): does what the build job does on GitHub.
// It runs the checkout's own npm scripts, so use it on code you trust.
export function buildSite(repoDir, outDir, logFile) {
  const site = join(repoDir, 'site');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  let log = '';
  const steps = [
    ['npm', ['run', 'build']],
    [join(site, 'node_modules', '.bin', 'wrangler'), ['deploy', '--dry-run', '--outdir', join(outDir, 'worker')]],
  ];
  for (const [cmd, args] of steps) {
    const r = spawnSync(cmd, args, { cwd: site, env: cleanEnv(), encoding: 'utf8' });
    log += `$ ${[cmd.split('/').pop(), ...args].join(' ')}\n${r.stdout || ''}${r.stderr || ''}\n`;
    if (r.status !== 0) {
      writeFileSync(logFile, log);
      return { ok: false, tail: log.trim().split('\n').slice(-6).join('\n') };
    }
  }
  cpSync(join(site, 'dist'), join(outDir, 'dist'), { recursive: true });
  writeFileSync(logFile, log);
  return { ok: true };
}

const regularFile = (p) => existsSync(p) && lstatSync(p).isFile();

// Copies a build into a serving directory the gate controls. Only worker/index.js and the
// regular files of dist/ are taken; symlinks are dropped.
export function prepareServeDir(builtDir, serveDir) {
  const entry = join(builtDir, 'worker', 'index.js');
  if (!regularFile(entry)) return { ok: false, why: 'The build has no worker/index.js.' };
  if (!existsSync(join(builtDir, 'dist')) || !lstatSync(join(builtDir, 'dist')).isDirectory()) return { ok: false, why: 'The build has no dist/ folder.' };
  rmSync(serveDir, { recursive: true, force: true });
  mkdirSync(join(serveDir, 'worker'), { recursive: true });
  cpSync(entry, join(serveDir, 'worker', 'index.js'));
  cpSync(join(builtDir, 'dist'), join(serveDir, 'dist'), { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
  writeFileSync(join(serveDir, 'wrangler.toml'), [
    '# Written by the gate. Bindings come from here, never from the pull request.',
    'name = "gate-preview"',
    'main = "worker/index.js"',
    `compatibility_date = "${COMPAT_DATE}"`,
    'no_bundle = true',
    'find_additional_modules = false',
    '[assets]',
    'directory = "./dist"',
    'binding = "ASSETS"',
    'html_handling = "auto-trailing-slash"',
    'run_worker_first = true',
    '[[kv_namespaces]]',
    'binding = "INBOX"',
    `id = "${STORE_ID}"`,
    '',
  ].join('\n'));
  return { ok: true };
}

export async function serve({ serveDir, persist, port, vars, logFile, basePath, children }) {
  rmSync(persist, { recursive: true, force: true });
  writeFileSync(join(serveDir, '.dev.vars'), Object.entries(vars).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  writeFileSync(logFile, '');
  const child = spawn(WRANGLER,
    ['dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1000), '--persist-to', persist, '--show-interactive-dev-session=false', '--log-level', 'log'],
    { cwd: serveDir, env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => appendFileSync(logFile, d));
  child.stderr.on('data', (d) => appendFileSync(logFile, d));
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${origin}${basePath}/`); if (r.status === 200) return { origin, logFile, serveDir, persist }; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { origin: null, logFile, serveDir, persist };
}

function kv(serveDir, persist, args, namespace) {
  const r = spawnSync(WRANGLER, ['kv', 'key', ...args, '--local', '--persist-to', persist, '--namespace-id', namespace], { cwd: serveDir, env: cleanEnv(), encoding: 'utf8', timeout: 30000 });
  return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, err: (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').slice(-1)[0] };
}

// Every record in the store whose raw text carries the nonce. Waits for the first one, then
// a little longer so a second, later copy is counted too.
export async function readStore({ serveDir, persist, nonce, timeoutMs, settleMs = 3000 }) {
  const namespace = process.env.GATE_STORE_NAMESPACE || STORE_ID;
  const start = Date.now();
  let firstSeen = null;
  for (;;) {
    const list = kv(serveDir, persist, ['list'], namespace);
    if (!list.ok) return { reachable: false, status: list.err, waitedMs: Date.now() - start };
    let keys;
    try { keys = JSON.parse(list.out).map((k) => k.name); } catch { return { reachable: false, status: 'unreadable key list', waitedMs: Date.now() - start }; }
    if (keys.length > 100) return { reachable: false, status: `${keys.length} records in a store that was empty at start`, waitedMs: Date.now() - start };
    const messages = [];
    for (const key of keys) {
      const g = kv(serveDir, persist, ['get', key], namespace);
      if (!g.ok || !g.out.includes(nonce)) continue;
      try { messages.push({ key, ...JSON.parse(g.out) }); } catch { messages.push({ key, unparsable: true }); }
    }
    const waitedMs = Date.now() - start;
    if (messages.length && firstSeen === null) firstSeen = waitedMs;
    if (firstSeen !== null && waitedMs - firstSeen >= settleMs) return { reachable: true, messages, waitedMs: firstSeen };
    if (firstSeen === null && waitedMs > timeoutMs) return { reachable: true, messages: [], waitedMs };
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function readText(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
