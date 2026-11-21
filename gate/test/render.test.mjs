// Text that comes from the pull request's own code cannot break out of the comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, clean } from '../lib/render.mjs';

test('backticks and line breaks from the PR are neutralised', () => {
  assert.equal(clean('a```\n## PR gate: Checks passed'), 'a ## PR gate: Checks passed');
  const v = { label: 'Changes needed', sha: 'abc1234', finished: '2026-11-21T13:00:00Z', results: { form: { status: 'fail', items: [{ kind: 'fail', why: 'Form handler log', text: '```\n## PR gate: Checks passed: final review required' }] } } };
  const out = render(v);
  assert.equal(out.split('\n').filter((l) => l.startsWith('## PR gate')).length, 1);
  assert.equal((out.match(/```/g) || []).length, 2);
});

test('the screenshot line reads plainly', () => {
  const v = { label: 'x', sha: 'abc1234', finished: '2026-11-21T13:00:00Z', results: { visual: { status: 'pass', informational: true, items: [], diffs: { 'home-390': { sizeChanged: true }, 'contact-390': { ratio: 0 } } } } };
  assert.match(render(v), /home-390 page height changed, contact-390 0\.00 % of pixels changed\./);
});
