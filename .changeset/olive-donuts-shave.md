---
---

No package release. `publint` now runs with `--strict` in all nine packages, so a
packaging warning fails the build instead of being printed and ignored. The
release workflow verifies every gate before it publishes, publishes by identity
token with no stored credential, and the release procedure is documented in
`docs/releasing.md`.
