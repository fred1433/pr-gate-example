# 3. The pull request and its verdict

Both pull requests were checked again on 21 Nov at 8:08 AM Central, under the current
gate (build in its own job, verdict computed from `main`), on their original commits.

- PR 2, from the vague request: "Changes needed" on commit `1ac954c`. Screenshots of
  `main` and the PR at 1440 and 390 px differ by 0.00 % of pixels; the test lead was
  never recorded while `main` recorded its control lead in 1.8 s; the form handler
  logged `lead_dropped ... "field":"case_details"`; the diff line renamed
  `name="case_details"` to `name="message"`. Closed without merging.
- PR 4, from the rewritten instruction: "Checks passed: final review required" on
  commit `f6c3833`, test lead recorded for intake@mockingbirdpike.example with all four
  fields. Merged by the reviewer (us, in this demo) as commit `41e23bf`.
- Live: deployed, post-deploy check passed, rollback drill run and checked, rolled
  forward. Every step is in `evidence/deploy-log.md`.
