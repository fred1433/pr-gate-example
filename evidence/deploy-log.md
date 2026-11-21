# Deploy and rollback log of the test site

Written by `ops/deploy.sh` and `ops/rollback.sh`. Times are US Central.
On 21 Nov, four lines of wrangler's interactive prompts were removed from the
rollback entry below; `ops/rollback.sh` now keeps them out of the log.

### 2026-11-21 07:04 CST deploy of commit f8b560c
Reason: Baseline before the contact form autocomplete change
Worker version: 3fb872a0-061d-4b69-a5f0-8b06fd65df84
```
ok   GET /demos/pr-gate-firm/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/contact/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/attorneys/ -> 200, x-robots-tag: noindex, nofollow
ok   visitor without test token lands on /demos/pr-gate-firm/not-sent/ ("Your message was not sent.")
ok   test lead 1f2dc93a20: page "Thank you. We received your request.", inbox has it for intake@mockingbirdpike.example after 1 s
POST-DEPLOY CHECK PASSED
```

### 2026-11-21 07:05 CST deploy of commit 41e23bf
Reason: PR 4 merged: autocomplete hints on the contact form
Worker version: a47fe578-a872-4745-a4ed-1855b4b70707
```
ok   GET /demos/pr-gate-firm/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/contact/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/attorneys/ -> 200, x-robots-tag: noindex, nofollow
ok   visitor without test token lands on /demos/pr-gate-firm/not-sent/ ("Your message was not sent.")
ok   test lead 9836727792: page "Thank you. We received your request.", inbox has it for intake@mockingbirdpike.example after 1 s
POST-DEPLOY CHECK PASSED
```

### 2026-11-21 07:06 CST rollback to version 3fb872a0-061d-4b69-a5f0-8b06fd65df84
Reason: Rollback drill: put the pre-PR-4 version back live
```
ok   GET /demos/pr-gate-firm/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/contact/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/attorneys/ -> 200, x-robots-tag: noindex, nofollow
ok   visitor without test token lands on /demos/pr-gate-firm/not-sent/ ("Your message was not sent.")
ok   test lead cb05aab54b: page "Thank you. We received your request.", inbox has it for intake@mockingbirdpike.example after 8 s
POST-DEPLOY CHECK PASSED
```
Checked by hand after the rollback: the live contact page no longer carries the
`autocomplete` attributes of PR 4 (`curl ... | grep -c autocomplete` gave 0), and
carries them again after the roll forward below (gave 1).

### 2026-11-21 07:06 CST deploy of commit 41e23bf
Reason: Roll forward after the drill: PR 4 live again
Worker version: c58afc92-ba7e-43b6-ba7e-caab53407229
```
ok   GET /demos/pr-gate-firm/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/contact/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/attorneys/ -> 200, x-robots-tag: noindex, nofollow
ok   visitor without test token lands on /demos/pr-gate-firm/not-sent/ ("Your message was not sent.")
ok   test lead 858311b9b2: page "Thank you. We received your request.", inbox has it for intake@mockingbirdpike.example after 1 s
POST-DEPLOY CHECK PASSED
```

### 2026-11-21 08:05 CST rollback to version 3fb872a0-061d-4b69-a5f0-8b06fd65df84
Reason: Rollback drill after the gate rewrite: put the pre-PR-4 version back live
```
Worker Version 3fb872a0-061d-4b69-a5f0-8b06fd65df84 has been deployed to 100% of traffic.
ok   GET /demos/pr-gate-firm/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/contact/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/attorneys/ -> 200, x-robots-tag: noindex, nofollow
ok   visitor without test token lands on /demos/pr-gate-firm/not-sent/ ("Your message was not sent.")
ok   test lead a21cce1422: page "Thank you. We received your request.", store recorded it for intake@mockingbirdpike.example after 2 s
POST-DEPLOY CHECK PASSED
```

### 2026-11-21 08:06 CST deploy of commit 6032ad3
Reason: Roll forward after the drill: current main (PR 4 included) live again
Worker version: bbb76ec2-a211-4dd8-b430-546b7cbc321d
```
ok   GET /demos/pr-gate-firm/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/contact/ -> 200, x-robots-tag: noindex, nofollow
ok   GET /demos/pr-gate-firm/attorneys/ -> 200, x-robots-tag: noindex, nofollow
ok   visitor without test token lands on /demos/pr-gate-firm/not-sent/ ("Your message was not sent.")
ok   test lead f41854f222: page "Thank you. We received your request.", store recorded it for intake@mockingbirdpike.example after 14 s
POST-DEPLOY CHECK PASSED
```
