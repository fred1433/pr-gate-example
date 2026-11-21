# Rules for the coding agent (example for this demo)

This file is an example written for a public demo. The firm is fictional and
the conventions are ours, not any agency's.

## How work arrives
- Each task comes from an operator as a written instruction.
- One task, one branch, one pull request. Never push to `main`.
- The PR description starts with the task as you received it, then a
  `Files in scope:` list naming every file you intend to touch.

## What you may change
- Pages, components and styles under `site/src/`.
- Text and layout, as long as the checks on the PR stay green.

## What needs a human decision
- Anything under `dns`, `env`, `domain` or `leads` in `sites.yaml`.
- `.github/`, `gate/`, `ops/` and `site/wrangler.toml`. Leave them alone.

## Facts you never type by hand
- Phone numbers, lead recipients and domains come from `sites.yaml`
  through `site/src/site.json`. Do not hard-code them in components.
