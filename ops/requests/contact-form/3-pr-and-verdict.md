# 3. The pull request and its verdict

- PR 2, from the vague request: "Changes needed". Screenshots of `main` and the PR
  at 1440 and 390 px differ by 0.00 % of pixels; the test lead never arrived; the form
  handler logged `lead_dropped ... "field":"case_details"`; the diff line renamed
  `name="case_details"` to `name="message"`. Closed without merging.
- PR 4, from the rewritten instruction: "Checks passed: final review required" on
  commit `f6c3833`, test lead received for intake@mockingbirdpike.example with all four
  fields. Approved by a person, merged as commit `41e23bf`.
- Live: deployed, post-deploy check passed, rollback drill run and checked, rolled
  forward. Every step is in `evidence/deploy-log.md`.
