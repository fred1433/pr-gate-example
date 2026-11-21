#!/usr/bin/env node
// Works out which pull request and which commit a finished "PR gate: build" run was for,
// from GitHub's own records, never from anything the build job produced.
// Writes pr, sha, base_sha, fork and skip to $GITHUB_OUTPUT.
//   - a pull_request run: the PR whose head is the run's commit (a newer push means skip);
//   - a workflow_dispatch run on main ("check PR n again"): PR n at its current head.
import { readFileSync, appendFileSync } from 'node:fs';

const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_OUTPUT } = process.env;
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_PATH) { console.error('GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required'); process.exit(2); }
const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
const run = event.workflow_run;
const api = async (path) => {
  const r = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${GITHUB_REPOSITORY}${path}`, { headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};
const out = (o) => {
  const text = Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, text);
  process.stdout.write(text);
};
const skip = (why) => { console.log(`skip: ${why}`); out({ skip: 'true' }); process.exit(0); };

let number = null;
if (run.event === 'pull_request') {
  number = (run.pull_requests || []).find((p) => p.head?.sha === run.head_sha)?.number;
  if (!number) {
    const owner = run.head_repository?.owner?.login;
    const list = await api(`/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}`);
    number = list.find((p) => p.head.sha === run.head_sha)?.number;
  }
  if (!number) skip(`no open pull request has ${run.head_sha} as its head`);
} else if (run.event === 'workflow_dispatch') {
  const repo = await api('');
  if (run.head_repository?.full_name !== GITHUB_REPOSITORY || run.head_branch !== repo.default_branch) skip('a manual run counts only when started on the default branch');
  number = Number((/PR (\d+)$/.exec(run.display_title || '') || [])[1]);
  if (!number) skip(`no PR number in the run title "${run.display_title}"`);
} else skip(`event ${run.event} is not checked`);

const pr = await api(`/pulls/${number}`);
if (run.event === 'pull_request' && pr.head.sha !== run.head_sha) skip(`PR ${number} has moved on to ${pr.head.sha}`);
out({ skip: 'false', pr: pr.number, sha: pr.head.sha, base_sha: pr.base.sha, fork: String(pr.head.repo?.full_name !== GITHUB_REPOSITORY) });
