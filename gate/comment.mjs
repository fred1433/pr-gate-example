#!/usr/bin/env node
// Posts the gate's verdict on the pull request, editing the gate's earlier comment
// instead of stacking a new one. Reads every page of comments to find it.
//   node gate/comment.mjs --waiting            (a new commit arrived: old verdict no longer applies)
//   node gate/comment.mjs --verdict out/comment.md
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA
import { readFileSync } from 'node:fs';

const MARK = '<!-- pr-gate -->';
const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA = '' } = process.env;
const argv = process.argv.slice(2);
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER) { console.error('GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required'); process.exit(2); }
if (!argv.includes('--waiting') && !argv.includes('--verdict')) { console.error('usage: comment.mjs --waiting | --verdict <file>'); process.exit(2); }
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

const mine = await findMine();
let body;
if (argv.includes('--waiting')) {
  const prev = mine ? (/## PR gate: (.+)/.exec(mine.body) || [])[1] : null;
  const prevSha = mine ? (/Commit `([0-9a-f]{7}|local)`/.exec(mine.body) || [])[1] : null;
  body = `${MARK}\n## PR gate: Waiting for new evidence\n\nCommit \`${HEAD_SHA.slice(0, 7)}\` is being checked.${prev && prevSha !== HEAD_SHA.slice(0, 7) ? ` The previous verdict ("${prev}", on commit \`${prevSha}\`) no longer applies.` : ''}\n`;
} else {
  body = readFileSync(argv[argv.indexOf('--verdict') + 1], 'utf8');
}
const r = mine
  ? await api(`/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  : await api(`/issues/${PR_NUMBER}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
if (!r.ok) { console.error(`comment failed: ${r.status} ${await r.text()}`); process.exit(1); }
console.log(`${mine ? 'updated' : 'created'} comment ${(await r.json()).id}`);
