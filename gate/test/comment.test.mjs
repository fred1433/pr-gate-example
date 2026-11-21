// The bot edits its earlier comment instead of stacking a new one, even when
// that comment sits on the third page of a busy pull request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fakeGitHub(pages) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET') {
        const page = Number(u.searchParams.get('page'));
        res.end(JSON.stringify(pages[page - 1] || []));
      } else res.end(JSON.stringify({ id: 999 }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

const filler = (n, start) => Array.from({ length: n }, (_, i) => ({ id: start + i, body: `someone else ${i}` }));
const run = (url, args) => new Promise((r) => {
  const p = spawn('node', [new URL('../comment.mjs', import.meta.url).pathname, ...args], {
    env: { ...process.env, GITHUB_API_URL: url, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '5', HEAD_SHA: 'abcdef1234567' },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', (code) => r({ code, out }));
});

test('finds its own comment on page 3 and edits it', async () => {
  const gh = await fakeGitHub([filler(100, 1), filler(100, 101), [...filler(4, 201), { id: 777, body: '<!-- pr-gate -->\n## PR gate: Checks passed: final review required\n\nCommit `1111111`' }]]);
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  writeFileSync(join(dir, 'c.md'), '<!-- pr-gate -->\n## PR gate: Changes needed\n');
  const r = await run(gh.url, ['--verdict', join(dir, 'c.md')]);
  gh.server.close();
  assert.equal(r.code, 0);
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 0);
  const patch = gh.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, '/repos/o/r/issues/comments/777');
});

test('a new commit after a green verdict marks it stale', async () => {
  const gh = await fakeGitHub([[{ id: 42, body: '<!-- pr-gate -->\n## PR gate: Checks passed: final review required\n\nCommit `1111111`, checked' }]]);
  const r = await run(gh.url, ['--waiting']);
  gh.server.close();
  assert.equal(r.code, 0);
  const patch = gh.calls.find((c) => c.method === 'PATCH');
  const body = JSON.parse(patch.body).body;
  assert.match(body, /Waiting for new evidence/);
  assert.match(body, /"Checks passed: final review required", on commit `1111111`\) no longer applies/);
});

test('no earlier comment: creates one', async () => {
  const gh = await fakeGitHub([[]]);
  const r = await run(gh.url, ['--waiting']);
  gh.server.close();
  assert.equal(r.code, 0);
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 1);
});
