# 9. The applications' browser suites are gates

Date: 2026-10-11
Status: Accepted

## Context

Both applications carry a Playwright suite that runs against the *built output*
in a real browser: `applications/docs-site/test/browser.ts` and
`applications/demo-store/test/browser.ts`. Each has a `playwright.config.ts`, a
`test:browser` script, and a `test-results/.last-run.json` recording a passing
run.

Neither suite was invoked by anything. `test:browser` was not a task in
`turbo.json`, not a script in the root `package.json`, and not referenced by any
workflow. The Vitest configurations do not pick them up either — both set
`include: ["test/*.test.ts"]`, so `browser.ts` is excluded from the fast layer
deliberately, and the comments in those two files say the browser half is the
point. The Git hooks are secret-scanning only. There was no automated caller on
any machine, including a developer's.

That left a specific set of claims resting on nothing that ran. The ones a unit
test cannot make are exactly the ones these applications are described by:

| Claim | Made where | Only checked by |
|---|---|---|
| `Permissions-Policy: tools=(self)` on a real served response | `demo-store/README.md`, `next.config.ts` | unwired browser suite |
| `/api/catalog` answers `501`, not an empty `200` | `demo-store/README.md` | unwired browser suite |
| structured data is valid and in the first byte of the response | — | unwired browser suite |
| the site runs the polyfill in the reader's browser | `docs-site/package.json` description | unwired browser suite |
| the search index is built locally, so a query never leaves the machine | `docs-site/README.md` | **nothing at all** |

The last row is the sharper problem, and it is a different defect from the
unwiring. `docs-site/test/browser.ts` documented, in its own header comment, an
assertion titled "Search is local" — and no such test existed in the file. The
README repeated the claim as fact and justified why asserting it mattered. A
test suite describing a guarantee it does not contain is worse than a missing
test, because a reader auditing the file concludes the guarantee is held.

`ci.yml` states the principle this repository holds itself to, in the comment
above the conformance job: *"A detector whose output nobody must close does not
make anything true."* That is a description of an unwired suite.

## Decision

**The application browser suites run on every change and fail the build.**

`test:browser` is a Turbo task with `dependsOn: ["build"]`, a root script, and a
step in the existing `toolchain` job in `.github/workflows/ci.yml`, after the
build it asserts against.

It is a step rather than a separate job, and the reason is the two conditions
that made `conformance` its own job — see ADR 0006, which split it out because
it needs all three engines rather than one and takes minutes rather than seconds.
Neither applies: `toolchain` already installs Chromium, and one Chromium run of
two single-file suites is seconds. Adding a fourth job would have bought
parallelism nobody needs and a duplicated browser install.

Two changes beyond adding the caller:

**The missing search test was written, not deleted.** The property is real —
Pagefind indexes the static output at build time — so the docblock's claim was
true and merely unasserted. Deleting the sentence would have made the file
honest and the README false. It is now asserted against the emitted JavaScript
rather than the build configuration, because a local indexer and a hosted search
service are configured identically and only the output distinguishes them.

The test inspects every JavaScript file the build emitted rather than the
`<script>` tags of one page. An earlier draft of it read the tags on a single
route, and a negative control proved that draft wrong: a planted off-origin
`fetch` in a chunk referenced only by another route passed. "No query leaves the
machine" is a property of the site, not of one route.

**The pattern is narrow on purpose.** The framework runtime, the client library
and the search index all ship XML namespace URIs, error-documentation links and
author profile URLs that are never requested. Matching any external string would
have made the test fail on the build it was written to protect, and a test that
does that is a test people delete. A host is a failure only where it is a
destination.

## What this decision does not claim

It does not claim the gate has been observed failing in a merge-blocking
position. It has been observed passing, repeatedly, and its negative controls
have been observed failing. ADR 0006 set a standard — *"the gate is proven, not
asserted"* — and the honest reading is that this gate is proven to fail when its
subject is broken, and not yet proven to fail a pull request in anger.

Every run behind this decision was on Windows. The workflow is `ubuntu-latest`.
The first run on the runner is the real observation.

Nor does it extend ADR 0006's reasoning automatically. That ADR is scoped to the
conformance suite and its expected-failure baseline. These suites have no
baseline and need none: they assert this repository's own applications, so a
failure is a failure and there is nothing to classify. The principle being
applied is the one stated in `ci.yml`, not the precedent set in ADR 0006.
