// The bot edits its earlier comment instead of stacking a new one, even when
// that comment sits on the third page of a busy pull request, and sets the
// "PR gate" commit status that the protection of main requires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

function fakeGitHub(pages, head = SHA) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname.endsWith('/pulls/5')) return res.end(JSON.stringify({ state: 'open', head: { sha: head } }));
      if (req.method === 'GET') return res.end(JSON.stringify(pages[Number(u.searchParams.get('page')) - 1] || []));
      res.end(JSON.stringify({ id: 999 }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

const filler = (n, start) => Array.from({ length: n }, (_, i) => ({ id: start + i, body: `someone else ${i}` }));
const run = (url, args) => new Promise((r) => {
  const p = spawn('node', [new URL('../comment.mjs', import.meta.url).pathname, ...args], {
    env: { ...process.env, GITHUB_API_URL: url, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '5', HEAD_SHA: SHA },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => r({ code, out }));
});
const verdictFile = (verdict, label) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const f = join(dir, 'verdict.json');
  writeFileSync(f, JSON.stringify({ verdict, label, sha: SHA.slice(0, 7), finished: '2026-11-21T13:00:00Z', results: { build: { status: 'pass', items: [] } } }));
  return f;
};
const statuses = (gh) => gh.calls.filter((c) => c.url.includes('/statuses/')).map((c) => JSON.parse(c.body));

test('finds its own comment on page 3, edits it, and sets the status', async () => {
  const gh = await fakeGitHub([filler(100, 1), filler(100, 101), [...filler(4, 201), { id: 777, body: '<!-- pr-gate -->\n## PR gate: Checks passed: final review required\n\nCommit `1111111`' }]]);
  const r = await run(gh.url, ['--publish', verdictFile('changes-needed', 'Changes needed'), '--selftest', 'success', '--gate-job', 'success']);
  gh.server.close();
  assert.equal(r.code, 0, r.out);
  assert.equal(gh.calls.filter((c) => c.method === 'POST' && c.url.includes('/comments')).length, 0);
  const patch = gh.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, '/repos/o/r/issues/comments/777');
  assert.match(JSON.parse(patch.body).body, /## PR gate: Changes needed/);
  assert.deepEqual(statuses(gh).map((s) => [s.state, s.context]), [['failure', 'PR gate']]);
});

test('a new commit after a green verdict marks it stale and the status pending', async () => {
  const gh = await fakeGitHub([[{ id: 42, body: '<!-- pr-gate -->\n## PR gate: Checks passed: final review required\n\nCommit `1111111`, checked' }]]);
  const r = await run(gh.url, ['--waiting']);
  gh.server.close();
  assert.equal(r.code, 0, r.out);
  const body = JSON.parse(gh.calls.find((c) => c.method === 'PATCH').body).body;
  assert.match(body, /Waiting for new evidence/);
  assert.match(body, /"Checks passed: final review required", on commit `1111111`\) no longer applies/);
  assert.equal(statuses(gh)[0].state, 'pending');
});

test('no earlier comment: creates exactly one', async () => {
  const gh = await fakeGitHub([[]]);
  const r = await run(gh.url, ['--waiting']);
  gh.server.close();
  assert.equal(r.code, 0, r.out);
  assert.equal(gh.calls.filter((c) => c.method === 'POST' && c.url.includes('/comments')).length, 1);
});

test('a failed self-test turns a green verdict into "Verification incomplete"', async () => {
  const gh = await fakeGitHub([[{ id: 42, body: '<!-- pr-gate -->\n## PR gate: Waiting for new evidence' }]]);
  const r = await run(gh.url, ['--publish', verdictFile('checks-passed', 'Checks passed: final review required'), '--selftest', 'failure', '--gate-job', 'success']);
  gh.server.close();
  assert.equal(r.code, 0, r.out);
  assert.match(JSON.parse(gh.calls.find((c) => c.method === 'PATCH').body).body, /## PR gate: Verification incomplete/);
  assert.equal(statuses(gh)[0].state, 'failure');
});

test('a gate job that did not finish is never green, even without a verdict file', async () => {
  const gh = await fakeGitHub([[]]);
  const r = await run(gh.url, ['--publish', '/nonexistent/verdict.json', '--selftest', 'success', '--gate-job', 'failure']);
  gh.server.close();
  assert.equal(r.code, 0, r.out);
  assert.equal(statuses(gh)[0].state, 'failure');
  assert.match(statuses(gh)[0].description, /Verification incomplete/);
});

test('when the PR moved on to a newer commit, only the status of the checked commit is set', async () => {
  const gh = await fakeGitHub([[{ id: 42, body: '<!-- pr-gate -->\n## PR gate: Waiting for new evidence' }]], 'f'.repeat(40));
  const r = await run(gh.url, ['--publish', verdictFile('checks-passed', 'Checks passed: final review required'), '--selftest', 'success', '--gate-job', 'success']);
  gh.server.close();
  assert.equal(r.code, 0, r.out);
  assert.equal(gh.calls.filter((c) => c.method === 'PATCH').length, 0);
  assert.equal(statuses(gh)[0].state, 'success');
});

test('missing arguments: usage, exit 2, nothing sent', async () => {
  const gh = await fakeGitHub([[]]);
  for (const args of [[], ['--publish'], ['--publish', '--selftest']]) {
    const r = await run(gh.url, args);
    assert.equal(r.code, 2, args.join(' '));
  }
  gh.server.close();
  assert.equal(gh.calls.length, 0);
});
