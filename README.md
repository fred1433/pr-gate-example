# PR gate example: a fictional law firm site checked before every merge

**Mockingbird & Pike is a fictional firm.** This repository is a public demo by
Frederic de Lavenne de Choulot (The AI Pipe). The site lives at
<https://theaipipe.com/demos/pr-gate-firm/>, carries a "fictional firm" banner and
`noindex`, and its contact form stores nothing unless the request carries a test token.

The pull requests here are written the way a coding agent writes them. A GitHub
Action checks each one and leaves a single verdict comment on it:

| Verdict | Meaning |
|---|---|
| Checks passed: final review required | Every check ran and passed on this commit. A person still approves the merge. |
| Changes needed | A check failed. The comment carries the proof: log line, diff line, screenshot. |
| Human decision required | The change touches DNS records, environment variables, the domain, lead routing, or the gate itself. |
| Verification incomplete | Something needed for the proof was missing: secrets, the inbox, or a working control run on `main`. Never green. |

## What the gate checks

`gate/run.mjs` builds `main` and the PR, starts both in the real Workers runtime
(`wrangler dev`), then:

1. **Contact form, end to end.** Fills the form at 390 px with a unique code, taps the
   button with a real click, and reads the test inbox until a message carrying that
   code arrives, addressed to the recipient in `sites.yaml`, with every field intact.
   A thank-you page or an HTTP 200 proves nothing on its own. The same test runs on
   `main` first; if `main` cannot deliver either, the verdict is "Verification incomplete".
2. **Screenshots** of `main` and the PR at 1440 and 390 px, with the share of pixels
   changed. Recorded for the reviewer, never enough to clear a PR.
3. **Internal links** (no dead links) and **click-to-call** (the dialed number and the
   shown number both match `sites.yaml`).
4. **`sites.yaml`** is valid, and fixed rules over the parsed diff flag DNS, env,
   domain and lead-routing changes with their exact line. A word like "DNS" in page
   text triggers nothing; an environment key renamed in code only is stopped.
5. **Scope**: files changed outside the PR's `Files in scope:` list need a person.

No model reads the diff. Every finding comes from code you can read in `gate/`.

## Commands

```sh
# unit tests of the rules and of the comment updater (no browser, no network)
npm ci --prefix gate && npm test --prefix gate

# the gate on fixture PRs, each against its expected verdict (needs both secrets set to any value)
npm ci --prefix site && npx --prefix gate playwright install chromium
FORM_TEST_TOKEN=any INBOX_TOKEN=any node gate/selftest.mjs
FORM_TEST_TOKEN=any INBOX_TOKEN=any node gate/selftest.mjs --only broken-form

# mutation test: the gate without its form check must let the broken form through,
# so this run is expected to FAIL (exit 1); that failure is the proof the check matters
FORM_TEST_TOKEN=any INBOX_TOKEN=any node gate/selftest.mjs --mutant no-form-check

# deploy and roll back the live test site (our Cloudflare account; prints usage without arguments)
ops/deploy.sh "<reason>"
ops/rollback.sh <version-id> "<reason>"
```

Results of these runs are kept in `evidence/`.

## Files

- `sites.yaml`, `CLAUDE.md`: an example registry and example agent rules written for
  this demo. Not any agency's format.
- `site/`: the Astro site and its form handler (`site/worker/index.js`).
- `gate/`: the checks, the self-test and the fixtures (`gate/fixtures/*.patch`, applied to the tag `fixtures-base`).
- `ops/`: deploy, rollback, post-deploy check, and `ops/requests/`, one operator task
  from vague request to delivery note.
- `.github/workflows/pr-gate.yml`: runs on `pull_request` (never `pull_request_target`).
  The gate's code is taken from `main`, so a PR cannot weaken the checks it is judged by.
  A PR from a fork gets no secrets and ends "Verification incomplete".

## Limits, stated plainly

- The gate only sees changes that go through this repository. A record edited by hand
  in a DNS or hosting dashboard never reaches it.
- The test inbox is a store the form handler writes to (Cloudflare KV), standing in for
  the email step. No email provider account is used in this demo.
- Merging stays a human decision.
