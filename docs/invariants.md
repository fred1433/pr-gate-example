# Invariants of the PR gate

Four properties the gate must keep. Each one has a test that fails when it is broken,
and I1 to I3 each have a mutant: a copy of the gate with that property removed, which
the tests must catch (`node gate/mutants.mjs`).

They were written after an outside review (21 Nov 2026) found a case against each of
I1, I2 and I3, and an inexact sentence about I4.

## I1. What is deployed is exactly the artifact that was tested

`ops/deploy.sh` never builds. It takes the evidence of a gate run (`verdict.json` and
`tested-build/`, the build the gate served and exercised), recomputes the fingerprint
of `tested-build/` (SHA-256 over every file path and content) and compares it with the
fingerprint the gate recorded in `verdict.json`. If they differ, it refuses (exit 3).
It also refuses a verdict that is "Changes needed" or "Verification incomplete", and a
checkout of `main` whose tree differs from the tested commit (exit 4).

Why: the reviewer added one line to `ContactForm.astro` that names the message field
`case_details` when `GITHUB_ACTIONS` is set and `message` otherwise. The build the gate
tested passed every check; the build the old `deploy.sh` made from the sources would
have lost every lead.

- Test: `gate/test/invariants.test.mjs`, "I1"; and the self-test case `env-sniff`,
  which builds the reviewer's change the way GitHub does, then rebuilds it the way the
  old script did, and requires `deploy.sh` to accept the first and refuse the second.
- Mutant: `deploy-skips-fingerprint` (the comparison in `deploy.sh` always succeeds).

## I2. The judged diff covers every path changed since the merge-base

The diff is `git diff --no-renames <merge-base>..<PR commit>`, read from git, with no
exclusion by name at any depth. The content the rules read is the committed blob of
that commit (`git cat-file`), not a file on disk. A PR checkout with uncommitted or
untracked files is refused: the gate judges commits.

Why: the earlier diff excluded `dist`, `site.json`, `node_modules` and a few more names
at every level. A PR adding `ops/dist/deploy-hook.sh` and `site/src/pages/dist/index.astro`
(a published page reading `env.STRIPE_KEY`) got an empty diff.

- Test: "I2" in `gate/test/invariants.test.mjs` (both paths seen, the page's key
  stopped, `ops/` sent to a person, main's own later commits left out), and the
  self-test case `dist-hidden`.
- Mutant: `diff-skips-dist` (paths with a `dist` segment dropped again).

## I3. Every read of an environment variable is recognized, whatever its form

Each changed code file under `site/` (`.astro`, `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`,
`.cts`, `.jsx`, `.tsx`) is parsed whole: `.astro` files are compiled by Astro's own
compiler (`@astrojs/compiler-rs`, the one the site builds with), and the code and the
`<script>` blocks are parsed by `@babel/parser`. The analysis walks the syntax tree:

- reads: `env.X`, `env?.X`, `env['X']`, `env?.['X']`, `import.meta.env.X`,
  `process.env.X`, `Astro.locals.runtime.env.X`, `'X' in env`, destructuring on one or
  several lines, nested (`{ runtime: { env: { X } } }`), with defaults or renames;
- aliases: `const e = env`, `env ?? {}`, a parameter of a local function that receives
  the environment, a destructured `{ env }`;
- uses it cannot name: `Object.keys(process.env)`, `{ ...env }`, `env[someVar]`, a rest
  element, the environment passed to a function defined elsewhere, `eval`, `new Function`.

A named key that the site registry does not declare is "Changes needed". A use it
cannot name, a file that does not parse, or a changed file of a type it does not read
is "Human decision required".

- Test: "I3" in `gate/test/invariants.test.mjs`, and the self-test case `env-sniff`
  (the reviewer's `Object.keys(process.env)` line, built with `GITHUB_ACTIONS` set so
  every runtime check passes: only this rule stops it).
- Mutant: `env-no-destructuring` (destructuring and aliases ignored).

## I4. The trust boundary of the workflow is described exactly

A pull request that edits a workflow file can replace the `PR gate` status: GitHub
keeps only the latest status per context, and the ruleset asks for `PR gate` set by
GitHub Actions, which is also where the edited job runs. The ruleset would accept it.
The edited job can also edit the bot's comment. The gate answers "Human decision
required" for any PR that touches `.github/`, but that verdict is one more status
under the same name, so it does not protect against this case.

The remedy is a GitHub App whose private key lives only in the `pr-gate` environment
(which runs only from `main`), and a ruleset that requires `PR gate` from that App.
It is not installed in this demo.

- Test: "I4" in `gate/test/invariants.test.mjs` (the README says exactly this, and a
  change under `.github/` gets "Human decision required").
