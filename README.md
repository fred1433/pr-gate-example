# PR gate example: a fictional law firm site checked before every merge

**Mockingbird & Pike is a fictional firm.** This repository is a public demo by
Frederic de Lavenne de Choulot (The AI Pipe). The site lives at
<https://theaipipe.com/demos/pr-gate-firm/>, carries a "fictional firm" banner and
`noindex`, and its contact form stores nothing unless the request carries a test token.

The pull requests here are staged: written the way a coding agent writes them, on
a fictional firm. The pull requests and the GitHub checks are real. A GitHub Action
checks each one, leaves a single verdict comment on it (edited, never stacked), and
sets a commit status named `PR gate`:

| Verdict | Meaning |
|---|---|
| Checks passed: final review required | Every check ran and passed on this commit. A person still merges. |
| Changes needed | A check failed. The comment carries the proof: log line, diff line, screenshot. |
| Human decision required | The change touches DNS records, environment variables, the domain, the office phone, lead routing, the agent's rules, the build, or the gate itself. |
| Verification incomplete | Something needed for the proof was missing: test tokens (a pull request from a fork never gets them), a readable test lead store, a working control run on `main`, or a passing self-test of the gate. Never green. |

Only the first one turns the `PR gate` status green. The other three set it red on
purpose, so that nothing is merged without a person.

**This demo records test submissions in a store; it does not test email delivery.**

## What the gate checks

1. **Contact form, end to end.** At 390 px, fills the form with a unique code and taps
   the button with a real click. Then it reads the test lead store and requires exactly
   one record carrying that code, addressed to the recipient in the site registry, with
   every field as typed. A thank-you page or an HTTP 200 proves nothing on its own. The
   page the visitor lands on must answer 200 with the same confirmation text as `main`.
   The same test runs on `main` first; if `main` cannot record its own control lead,
   the verdict is "Verification incomplete".
2. **Screenshots** of `main` and the PR at 1440 and 390 px, with the share of pixels
   changed. Recorded for the reviewer, never enough to clear a PR.
3. **Internal links** (no dead links) and **click-to-call** (the dialed number and the
   shown number both match the registry).
4. **`site-registry.yaml`** is valid, and fixed rules over the parsed diff flag DNS, env,
   domain, phone and lead-routing changes with their exact line. A word like "DNS" in
   page text triggers nothing. An environment key renamed in code only is stopped,
   whether the code reads `env.X`, `env['X']` or `const { X } = env`.
5. **Protected files**: `.github/`, `gate/`, `ops/` scripts, `CLAUDE.md`,
   `site/wrangler.toml` and the build files (`site/package.json`, its lock file,
   `site/scripts/`, `site/astro.config.mjs`) always need a person.
6. **Scope**: files changed outside the PR's `Files in scope:` list need a person.

No model reads the diff. Every finding comes from code you can read in `gate/`.

"Preview" in this repository means the PR's build, served and exercised inside the
check. It is not a deployed URL. On a host with per-PR preview URLs, such as Vercel,
the same checks would aim at that URL.

## Trust boundary: what a pull request can and cannot do to its own verdict

The workflow is split in two.

- **`PR gate: build`** (`.github/workflows/pr-gate-build.yml`, on `pull_request`) runs
  the pull request's code: `npm ci`, the build, the worker bundle. It has no secret and
  a read-only token. Its only output is an artifact: `dist/` and `worker/index.js`.
- **`PR gate`** (`.github/workflows/pr-gate.yml`, on `workflow_run`) computes the
  verdict. GitHub always runs a `workflow_run` workflow from `main`, so a pull request
  cannot edit it. Its jobs:
  - `gate` takes its code, its pinned wrangler and the serving config from `main`,
    reads the PR as data (diff, registry), and serves the build artifact in workerd,
    which has no access to the disk, with a fresh local store. The store is read back
    by the gate through wrangler's local commands, not through an endpoint of the PR.
    Its token is read-only.
  - `selftest` runs the unit tests and every fixture case of `gate/selftest.mjs`.
    If it fails, the verdict is at best "Verification incomplete".
  - `publish` posts the comment and the `PR gate` status. It runs none of the PR's
    code; it reads the verdict file and calls the GitHub API.
- No secret is stored in GitHub. Test tokens are drawn at random for each run, and
  withheld for a pull request from a fork.
- `main` is protected by a ruleset: a merge needs the `PR gate` status, set by GitHub
  Actions, to be green. The repository owner can override it; that is how a person
  takes a "Human decision required". The `pr-gate` environment only runs from `main`.

What this guarantees: the PR's build scripts, dependencies and site code never run
where the verdict is computed, where a write token exists, or where they could reach
the verdict file. A build script that tries to rewrite the verdict (PR 9 of this demo)
only touches its own throwaway job, and changing build files needs a person anyway.

What it does not guarantee: someone allowed to push branches here can also edit the
build workflow, and GitHub runs that edited copy for their pull request, with the token
permissions it asks for, setting a commit status included. The verdict workflow still
comes from `main` and answers "Human decision required" for any change under
`.github/`, but a status set by the edited job would sit beside it. Give the coding
agent a token without the `workflow` permission and GitHub refuses any push that edits
a workflow file.

## Commands

```sh
# unit tests of the rules, the comment and the status (no browser, no network)
npm ci --prefix gate && npm test --prefix gate

# the gate on fixture PRs, each against its expected verdict
npm ci --prefix site && npx --prefix gate playwright install chromium
node gate/selftest.mjs
node gate/selftest.mjs --only broken-form

# mutation test: the gate without its form check must let the broken form through,
# so this run is expected to FAIL (exit 1); that failure is the proof the check matters
node gate/selftest.mjs --mutant no-form-check

# the gate on two checkouts of your own (it builds both: use it on code you trust)
node gate/run.mjs --base <main checkout> --pr <PR checkout> --out <dir> --pr-body <file>

# check a pull request again on GitHub (also works for a closed or merged one)
gh workflow run "PR gate: build" -f pr=<number>

# deploy and roll back the live test site (our Cloudflare account; prints usage without arguments)
ops/deploy.sh "<reason>"
ops/rollback.sh <version-id> "<reason>"
```

Results of these runs are kept in `evidence/`.

## Files

- `site-registry.yaml`, `CLAUDE.md`: an example site registry and example agent rules
  written for this demo. Not any agency's format.
- `site/`: the Astro site and its form handler (`site/worker/index.js`).
- `gate/`: the checks, the self-test and the fixtures (`gate/fixtures/*.patch`, applied
  to the tag `fixtures-base`).
- `ops/`: deploy, rollback, post-deploy check, and `ops/requests/`, one operator task
  from vague request to delivery note.

## Limits, stated plainly

- The gate only sees changes that go through this repository. A record edited by hand
  in a DNS or hosting dashboard never reaches it.
- The test lead store is Cloudflare KV, written by the form handler in place of the
  email step. No email provider account is used, and email delivery is not tested.
- PR 2 and PR 4 were written before `sites.yaml` was renamed `site-registry.yaml`.
  Their commits are kept as they were reviewed, so the gate reads the old name there.
- Merging stays a human decision.
