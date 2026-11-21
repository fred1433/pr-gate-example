#!/usr/bin/env node
// Posts the gate's result on the pull request: one comment, edited in place (never a
// second one), and a commit status named "PR gate" on the commit that was checked.
//   node gate/comment.mjs --waiting
//       a new commit arrived: the old verdict no longer applies, the status goes back to pending
//   node gate/comment.mjs --publish <verdict.json> [--selftest <job result>] [--gate-job <job result>]
//       the verdict; it becomes "Verification incomplete" if the gate job did not finish
//       or if the gate's own self-test failed on this run
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, optional RUN_URL.
// This step runs none of the pull request's code: it reads a JSON file and calls the GitHub API.
import { readFileSync, existsSync } from 'node:fs';
import { render, VERDICTS } from './lib/render.mjs';

const MARK = '<!-- pr-gate -->';
const CONTEXT = 'PR gate';
const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA = '', RUN_URL } = process.env;
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i === -1 ? null : argv[i + 1] ?? null; };
const usage = 'usage: comment.mjs --waiting | --publish <verdict.json> [--selftest <result>] [--gate-job <result>]';
if (!argv.includes('--waiting') && !argv.includes('--publish')) { console.error(usage); process.exit(2); }
if (argv.includes('--publish') && (!opt('publish') || opt('publish').startsWith('--'))) { console.error(usage); process.exit(2); }
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !/^\d+$/.test(PR_NUMBER || '') || !/^[0-9a-f]{40}$/.test(HEAD_SHA)) {
  console.error('GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER (a number) and HEAD_SHA (a full commit id) are required'); process.exit(2);
}
const api = (path, init = {}) => fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${GITHUB_REPOSITORY}${path}`, {
  ...init, headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
});

async function findMine() {
  for (let page = 1; page < 50; page++) {
    const r = await api(`/issues/${PR_NUMBER}/comments?per_page=100&page=${page}`);
    if (!r.ok) throw new Error(`list comments: ${r.status}`);
    const list = await r.json();
    const hit = list.find((c) => c.body && c.body.startsWith(MARK));
    if (hit) return hit;
    if (list.length < 100) return null;
  }
  return null;
}

async function setStatus(state, description) {
  const r = await api(`/statuses/${HEAD_SHA}`, { method: 'POST', body: JSON.stringify({ state, context: CONTEXT, description: description.slice(0, 140), ...(RUN_URL ? { target_url: RUN_URL } : {}) }) });
  if (!r.ok) { console.error(`status failed: ${r.status} ${await r.text()}`); process.exitCode = 1; }
}

async function upsert(body) {
  const mine = await findMine();
  const r = mine
    ? await api(`/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
    : await api(`/issues/${PR_NUMBER}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  if (!r.ok) { console.error(`comment failed: ${r.status} ${await r.text()}`); process.exit(1); }
  console.log(`${mine ? 'updated' : 'created'} comment ${(await r.json()).id}`);
  return mine;
}

if (argv.includes('--waiting')) {
  const mine = await findMine();
  const prev = mine ? (/## PR gate: (.+)/.exec(mine.body) || [])[1] : null;
  const prevSha = mine ? (/Commit `([0-9a-f]{7}|local)`/.exec(mine.body) || [])[1] : null;
  const stale = prev && prevSha && prevSha !== HEAD_SHA.slice(0, 7) && !/Waiting/.test(prev) ? ` The previous verdict ("${prev}", on commit \`${prevSha}\`) no longer applies.` : '';
  await upsert(`${MARK}\n## PR gate: Waiting for new evidence\n\nCommit \`${HEAD_SHA.slice(0, 7)}\` is being checked.${stale}\n`);
  await setStatus('pending', 'Waiting for new evidence');
} else {
  const file = opt('publish');
  const selftest = opt('selftest'), gateJob = opt('gate-job');
  let v = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (!v || (gateJob && gateJob !== 'success')) {
    v = { verdict: 'verification-incomplete', label: VERDICTS['verification-incomplete'], sha: HEAD_SHA.slice(0, 7), finished: new Date().toISOString(),
      results: { gate: { status: 'incomplete', items: [{ kind: 'incomplete', why: `The gate job did not finish (${gateJob || 'no verdict file'}), so nothing about this commit is proven.` }] } } };
  }
  if (v.sha !== HEAD_SHA.slice(0, 7)) { console.error(`verdict is for ${v.sha}, not ${HEAD_SHA.slice(0, 7)}`); process.exit(1); }
  if (selftest) {
    v.selftest = selftest === 'success' ? 'every fixture case and unit test passed' : `failed (${selftest})`;
    if (selftest !== 'success') {
      v.results.selftest = { status: 'incomplete', items: [{ kind: 'incomplete', why: "The gate's own self-test did not pass on this run, so its verdict is not trusted." }] };
      if (v.verdict !== 'changes-needed') { v.verdict = 'verification-incomplete'; v.label = VERDICTS[v.verdict]; }
    }
  }
  // A newer commit may have arrived while this one was checked: then only its status is set.
  const pr = await (await api(`/pulls/${PR_NUMBER}`)).json();
  if (pr.state === 'open' && pr.head?.sha !== HEAD_SHA) console.log(`PR head moved to ${pr.head?.sha}; comment left to the newer run`);
  else await upsert(render(v, { runUrl: RUN_URL }));
  await setStatus(v.verdict === 'checks-passed' ? 'success' : 'failure', v.label);
  console.log(v.label);
}
