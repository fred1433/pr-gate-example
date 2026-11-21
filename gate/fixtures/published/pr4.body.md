Task (rewritten by the operator, replaces the earlier "clean up the contact form" PR):
Add autocomplete hints to the contact form so a phone can fill it in one tap.
- Keep every `name` attribute exactly as it is: name, email, phone, case_details. The form handler and sites.yaml depend on them.
- Keep the button label "Send to our intake team" and the thank-you page.
- No visual change at 1440 or 390 px.
- Done when the gate shows a test message arriving for intake@mockingbirdpike.example with all four fields.

Added `autocomplete="name"`, `"email"` and `"tel"`. Field names unchanged.

Files in scope:
- `site/src/components/ContactForm.astro`

