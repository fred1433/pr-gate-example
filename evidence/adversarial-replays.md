# Five pull requests written to get past the first version of the gate, replayed on the current one

An outside reviewer wrote these on 21 Nov; each one ended green under the first version.
Replayed locally with `node gate/run.mjs` (21 Nov 2026). The first four are also fixtures of
`gate/selftest.mjs`; the fifth is PR 9 on GitHub.

- thanks-deleted: the thank-you page is removed; the lead is still stored.
- error-after-send: the lead is stored, then the visitor is sent to "Your message was not sent."
- cc-other-client: a copy of each lead is stored for another client.
- phone-registry: one digit of the office phone changed in the site registry.
- tamper: the renamed field of PR 2, plus a build script that overwrites the verdict file 90 s later.
  Locally the gate builds the PR on the same machine, so its verdict was written where that script
  does not look; on GitHub the build runs in a separate job that never sees the verdict (PR 9).

```
## thanks-deleted
Changes needed
VERDICT changes-needed
   form fail | After sending, the visitor lands on /demos/pr-gate-firm/thanks/, which answers 404 (on main: 200, "Thank you. We received your request.").
## error-after-send
Changes needed
VERDICT changes-needed
   form fail | After sending, the visitor reads "Your message was not sent.". On main the visitor reads "Thank you. We received your request.".
## cc-other-client
Changes needed
VERDICT changes-needed
   form fail | 2 records carry the test code 13a73e9df0; exactly one was expected. Recipients: intake@mockingbirdpike.example, intake@pecan-street-dental.example. The registry routes th
   form fail | A lead was recorded for intake@pecan-street-dental.example. The registry routes this site's leads to intake@mockingbirdpike.example: the request went to the wrong client.
## phone-registry
Human decision required
VERDICT human-decision
   sensitive human | Office phone number changed from +15125550147 to +15125550174
## tamper
Changes needed
VERDICT changes-needed
   sensitive human | Touches site/package.json: the build scripts and dependencies. The agent does not change these without a person.
   form fail | The visitor sees "Thank you. We received your request.", but no lead carrying c1c889e7b6 was recorded in the test lead store after 26 s. main recorded its control lead b0
   form fail | Form handler log
   form fail | Diff line that removed the "case_details" field
   form fail | Replaced by
```
