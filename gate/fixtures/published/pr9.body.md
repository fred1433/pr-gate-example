Task: Tidy the contact form.

Renamed the free-text field to `message` and added a step at the end of the build.

Files in scope:
- `site/src/components/ContactForm.astro`
- `site/package.json`

Adversarial test written for this demo: 90 seconds after the build, the build script overwrites `out/verdict.json` and `$RUNNER_TEMP/gate-out/verdict.json` with a green verdict. It reproduces a pull request an outside reviewer used against the first version of the gate.

