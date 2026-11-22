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
| Human decision required | The change touches DNS records, environment variables, the domain, the office phone, lead routing, the agent's rules, the build, or the gate itself, or it changes anything other than markup, style and content under `site/`: code, a file outside the site, a link. |
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
   page text triggers nothing.
5. **Only markup, style and content pass on their own.** This is an allowlist: a pull
   request can be green only if every file it changes is markup, style or content under
   `site/`. Code (the worker, `.js`, `.mjs`, `.ts`, `.cjs`, the build configuration, a
   changed Astro frontmatter, a `<script>` in any case), any file added or modified under
   `site/public/` (served as it is, whatever its extension), a file outside `site/`
   (except the operator notes in `ops/requests/`), a symbolic link or a change of mode,
   and an unknown extension all need a person, with the reason. So do, in `.astro`, `.md`,
   `.html`, `.svg` and `.xml` files: an `on*` attribute (also `/onload` or `"x"onerror`),
   `<base>`, `<iframe>`, `<object>`, `<embed>`, `<meta http-equiv>`, a `javascript:`,
   `vbscript:` or `data:` URL in `href`, `src`, `action`, `formaction`, `xlink:href` or
   `srcset` (entities decoded, controls and spaces removed, any case, expressions
   included), and a style that loads from another domain (`@import`, `url()`). Markdown
   and HTML are read with parse5, `.astro` files with Astro's own compiler. Inside
   `.astro` files, a frontmatter that only imports `.astro` components and a template
   expression made only of literals and names (or member reads) declared in a
   frontmatter the pull request leaves unchanged (``{`${base}/privacy/`}``) count as
   markup; a call, an operator or a name the pull request brings needs a person. The
   list of what passes is in [`docs/invariants.md`](docs/invariants.md), I3.
   This check is built to catch an agent's mistakes. It is not a sandbox against a hostile author: a pull request written to slip code past it can succeed, which is why code changes and new files under `site/public/` go to a person and why the agent's token should not hold the workflow permission.
   Two consequences we accept: a name already declared on `main` that is a function
   would be called by Astro (code already on `main` and reviewed; a hostile author is out
   of scope), and importing an existing `.astro` component that computes things, with
   literal props, passes on its own: that component's code runs.
   As secondary information, code files under `site/` are parsed whole and a key the
   registry does not declare is "Changes needed" with its line, in the forms listed:
   `env.X`, `env?.X`, `env['X']`, a destructuring over several lines, an alias, a
   function parameter that receives the environment. A use the gate cannot name
   (`Object.keys(process.env)`, `{ ...env }`, `env[someVar]`) is reported for the
   person, who decides anyway.
6. **Protected files**: `.github/`, `gate/`, `ops/` scripts, `CLAUDE.md`,
   `site/wrangler.toml` and the build files (`site/package.json`, its lock file,
   `site/scripts/`, `site/astro.config.mjs`) always need a person.
7. **Scope**: files changed outside the PR's `Files in scope:` list need a person.

The diff behind checks 4 to 7 is git's, from the merge-base to the PR commit, with no
path left out: a file under a folder called `dist` is judged like any other.

What the gate tested is what gets deployed: the PR's build is copied into
`tested-build/`, fingerprinted (SHA-256 over every path and content), served from that
copy, and kept with the evidence. `ops/deploy.sh` deploys that copy and nothing else,
and refuses if its fingerprint differs. It never builds.

The four properties above that an outside review broke once, and their tests, are in
[`docs/invariants.md`](docs/invariants.md).

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
    reads the PR as data (diff, registry), fingerprints the build artifact, and serves it in workerd,
    which has no access to the disk, with a fresh local store. The store is read back
    by the gate through wrangler's local commands, not through an endpoint of the PR.
    Its token is read-only.
  - `selftest` runs the unit tests, the mutation test of the invariants
    (`gate/mutants.mjs`) and every fixture case of `gate/selftest.mjs`.
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

What it does not guarantee: a pull request that edits a workflow file can replace the
`PR gate` status. GitHub keeps only the latest status for each context, and the ruleset
asks for `PR gate` set by GitHub Actions, which is also where an edited workflow runs. A
`pull_request` job that grants itself `statuses: write` can wait for the verdict, then
post a green `PR gate` over it, and the ruleset would accept it. It can edit the bot's
comment too. Anyone who pushes a branch with a token that has the `workflow` scope can do
this; the token that pushed this demo's pull requests has that scope.

Every pull request that touches `.github/` already gets "Human decision required". That
does not protect against this case: the verdict is one more status under the same name,
and the edited job can replace it.

The remedy is a GitHub App whose private key lives only in the `pr-gate` environment
(which runs only from `main`): the `publish` job posts the verdict with that App, and the
ruleset requires `PR gate` from that App alone. It is not installed in this demo. Until
it is, give the coding agent a token without the `workflow` scope: GitHub then refuses
any push that edits a workflow file.

## Commands

```sh
# unit tests of the rules, the comment, the status and the four invariants (no browser)
npm ci --prefix gate && npm test --prefix gate

# the gate on fixture PRs, each against its expected verdict
npm ci --prefix site && npx --prefix gate playwright install chromium
node gate/selftest.mjs
node gate/selftest.mjs --only broken-form

# the nine pull requests on GitHub, replayed locally: each must get its posted verdict
# again (fetches their commits from origin, read only, and builds them)
node gate/selftest.mjs --published

# mutation test: the gate without its form check must let the broken form through,
# so this run is expected to FAIL (exit 1); that failure is the proof the check matters
node gate/selftest.mjs --mutant no-form-check

# invariant tests and their mutants: each mutant removes one invariant (docs/invariants.md)
# and the run passes only if the tests catch every one of them
node gate/mutants.mjs

# the gate on two worktrees of one clone, the PR one fully committed
# (it builds both: use it on code you trust)
git worktree add ../main-wt main && git worktree add ../pr-wt <PR branch>
npm ci --prefix ../main-wt/site && npm ci --prefix ../pr-wt/site
node gate/run.mjs --base ../main-wt --pr ../pr-wt --out <dir> --pr-body <file>

# check a pull request again on GitHub (also works for a closed or merged one)
gh workflow run "PR gate: build" -f pr=<number>

# deploy the build a gate run tested, from a checkout of that commit (our Cloudflare
# account; prints usage without arguments; --dry-run checks everything, needs no token)
gh run download <gate run id> -n gate-evidence -D <dir>
ops/deploy.sh [--dry-run] <dir> "<reason>"
ops/rollback.sh <version-id> "<reason>"
```

Results of these runs are kept in `evidence/`.

## Files

- `site-registry.yaml`, `CLAUDE.md`: an example site registry and example agent rules
  written for this demo. Not any agency's format.
- `site/`: the Astro site and its form handler (`site/worker/index.js`).
- `gate/`: the checks, the self-test and the fixtures (`gate/fixtures/*.patch`, applied
  to the tag `fixtures-base` and committed, so the gate reads them through git), and the
  mutation test (`gate/mutants.mjs`).
- `docs/invariants.md`: what the gate must keep, and the test and mutant for each.
- `ops/`: deploy, rollback, post-deploy check, and `ops/requests/`, one operator task
  from vague request to delivery note.

## Limits, stated plainly

- The gate only sees changes that go through this repository. A record edited by hand
  in a DNS or hosting dashboard never reaches it.
- The test lead store is Cloudflare KV, written by the form handler in place of the
  email step. No email provider account is used, and email delivery is not tested.
- PR 2 and PR 4 were written before `sites.yaml` was renamed `site-registry.yaml`.
  Their commits are kept as they were reviewed, so the gate reads the old name there.
- Code written to detect the test cannot pass on its own: every code change goes to a
  person. That person still has to see it. The gate names environment reads in the forms
  listed in check 5; anything else that tells the check apart from production (a date,
  the host name, the request headers) is for the person who reads the diff. Deploying
  only the tested build means such code cannot behave differently once deployed than it
  did under the check, at build time; at run time it still can.
- Merging stays a human decision.
