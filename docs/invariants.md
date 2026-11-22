# Invariants of the PR gate

Four properties the gate must keep. Each one has a test that fails when it is broken,
and I1 to I3 have mutants: copies of the gate with part of that property removed, which
the tests must catch (`node gate/mutants.mjs`).

They were written after an outside review (21 Nov 2026) found a case against each of
I1, I2 and I3, and an inexact sentence about I4. A third review the same day got past
I3 again; I3 is now an allowlist. A fourth review the same day ran JavaScript on the page
through it (a file under `site/public/`, an encoded `javascript:` URL, a handler written
`/onload`); each of those forms now needs a person, with a test, a fixture and, for the
first two fixes, a mutant.

This check is built to catch an agent's mistakes. It is not a sandbox against a hostile author: a pull request written to slip code past it can succeed, which is why code changes and new files under `site/public/` go to a person and why the agent's token should not hold the workflow permission.

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

## I3. Only markup, style and content can pass on their own

A pull request gets "Checks passed" only if every file it changes is markup, style or
content under `site/`. This is an allowlist: it names what may pass. It is built to catch
an agent's mistakes, not to stop a hostile author (see the top of this file). Everything
else gets "Human decision required", with the reason (`gate/lib/allowlist.mjs`):

- **Executable code, changed, added or removed**: the worker and every `.js`, `.mjs`,
  `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx`, `.tsx` (also `.mdx`, `.vue`, `.svelte`, `.wasm`,
  `.sh`); the build configuration (`astro.config.*`, `vite.config.*`, `package.json`, any
  `.json`, `.yaml`, `.toml` or dotfile under `site/`); in an `.astro` file, a changed
  frontmatter, a `<script>` (any case) added, changed or removed, an event handler
  attribute, `set:html`, `srcdoc`.
- **Any file added or modified under `site/public/`**, whatever its extension (`.xml` and
  `.svg` included): it is served as it is and nothing else checks it.
- **Markup that runs or loads something**, in `.astro`, `.md`, `.html`, `.svg` and `.xml`
  (Markdown and HTML read with parse5): `<script>` in any case, `<base>`, `<iframe>`,
  `<object>`, `<embed>`, `<meta http-equiv>`, and any `on*` attribute, with or without a
  space before it (`/onload`, `"x"onerror`).
- **A `javascript:`, `vbscript:` or `data:` URL** in `href`, `src`, `action`,
  `formaction`, `xlink:href`, `srcset` (and a `javascript:` or `vbscript:` value in any
  attribute), after HTML entities are decoded and control characters and spaces removed,
  in any case; for an expression, its literal parts and the names bound to a literal. In
  Markdown, link destinations, reference definitions and autolinks too.
- **A style that loads from another domain**: `@import` or `url()` to an absolute or
  protocol-relative URL, after CSS escapes, in a stylesheet, a `<style>`, a `style`
  attribute, or a `<link rel="stylesheet">`.
- **A file outside `site/`**, except Markdown or text under `ops/requests/`.
- **A symbolic link**, whatever it points to, **or a change of mode**, read from
  `git diff --raw` (a new file must be a plain `100644` file).
- **An extension the gate does not know.**

Two forms inside `.astro` files are allowed, because they are markup:

- a frontmatter made only of default imports of a relative `.astro` file inside `site/`
  (`import Base from '../../layouts/Base.astro';`). A component imported that way and
  changed in the same pull request is judged by this rule like any other file;
- a template expression made only of literals and of names (or member reads of them)
  declared in a frontmatter the pull request leaves unchanged, code already on `main`:
  `{title}`, `{site.phone.display}`, ``{`${base}/privacy/`}``. No call, no operator, no
  computed key, nothing from `Astro`, `process` or `import.meta`, and no name the pull
  request brings, not even one from an allowed import. Only expressions the pull request
  adds are judged; those already on `main` are not.

Two limits follow, and are accepted. A name already declared on `main` that is a function
would be called by Astro: that is code already on `main` and reviewed, and a hostile
author is out of scope. Importing an existing `.astro` component that computes things,
with literal props, passes on its own, and that component's code runs.

The three green pull requests posted on GitHub (1, 4 and 8) keep their verdict under this
rule: text, static attributes, a link built from `base`, and a new page whose frontmatter
only imports the layout. `node gate/selftest.mjs --published` replays all nine.

The detection of environment reads stays, as secondary information: a key the site
registry does not declare, read in one of the forms listed in the test (`env.X`,
`env?.X`, `env['X']`, destructuring, aliases, a parameter that receives the
environment, `import.meta.env.X`, `process.env.X`), is still "Changes needed" with its
line. "Checks passed" no longer depends on it.

Why: two reviews in a row (21 Nov 2026) got "Checks passed" past a list of forbidden
forms. The second renamed the handler's parameter (`fetch(request, bindings)`) and read
the key from a module outside `site/`; the third made `site/src/lib/brand.mjs` a link to
a `.yaml` file that holds code, which the build followed. Its other forms were
`import { env as cf } from 'cloudflare:workers'`, `process['en'+'v']`,
`Reflect.get(process, 'env')` and `arguments[1]`. A list of forbidden forms is never
complete.

- Tests: the "I3" tests in `gate/test/invariants.test.mjs`, one per category (code,
  outside `site/`, link and mode, unknown extension), one for what passes (the three
  green pull requests among them), one for every reviewer form, and one for the
  environment reads; one per fix of the fourth review (`site/public/`, names the pull
  request brings, URL schemes, markup that runs or loads, remote styles). Self-test cases
  `reviewer-c1`, `reviewer-c3` and one per form, then `public-files`,
  `template-new-name`, `url-scheme`, `markup-loaders` and `remote-style`, all built whole
  and all "Human decision required".
- Mutants: `allowlist-mjs-passes` (a modified `.mjs` taken for a stylesheet),
  `template-call-passes` (a call allowed in a template expression),
  `import-non-astro-passes` (a frontmatter import of a non-`.astro` file allowed),
  `public-by-extension` (a file under `site/public/` judged by its extension again),
  `template-pr-name-passes` (a name the pull request brings allowed in an expression), and
  `env-no-destructuring` (the secondary detection loses destructuring and aliases).

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
