# Conformance baseline

Conformance here means one thing: zero unexpected failures against the pinned
draft named below. It never means blanket green, because the reference browser
itself does not pass the whole official suite.

Pinned draft: WebMCP Draft Community Group Report, 2 October 2026
(upstream `d61d0e6`), exported as `SPEC_VERSION` from `@ax-kit/core`.

## Layers

- Fast layer (`happy-dom`): pure logic — name validation, schema rejection,
  serialization edges, sorting, gate wiring.
- Browser layer (real Chromium via Vitest Browser Mode): everything touching
  `document.modelContext` - `EventTarget` semantics, `AbortSignal` races, the
  error taxonomy, Permissions Policy gating, origin logic, per-frame
  isolation. Run with `pnpm test`; the `chromium` project needs a Playwright
  Chromium install (`pnpm exec playwright install chromium`).
- Official layer (WPT `/webmcp`): the specification's own suite, run against the
  built bundle. The signal is the diff against the expected-failure list, not
  the raw count. See [Official layer](#official-layer-wpt-webmcp) below.

## Decided behaviors

- Omitted `executeTool` arguments default to `{}`. Verified 2026-09-28
  against upstream `webmcp/imperative/object-arguments.https.html`, which
  asserts the default alongside array acceptance and `TypeError` for
  primitives, null, and `toJSON`-yields-undefined objects.
- Change notification is queued as a task, never fired synchronously, so
  listeners cannot run inside the registering call. Decided 2026-09-28 from
  review: the draft queues one task per target on its task source.
  `MessageChannel` posts a real task without timers; where the platform hides
  it, a microtask is the closest ordering available (graceful degradation,
  still never synchronous).
- Handler attributes (`ontoolchange` and siblings) follow standard
  `EventHandler` semantics via one internal wrapper per event type:
  non-functions collapse to null, and explicit listeners are never disturbed.
  Decided 2026-09-28 from review.
- An unrecognized Permissions Policy feature does not deny installation;
  only a recognized-but-denied `tools` feature does. Decided 2026-09-28 from
  review: `allowsFeature` reports false for unknown features too.
- Allow-list entries that serialize to the opaque origin are rejected with
  `SecurityError`, so a file-scheme entry can never match an opaque caller.
  Deliberately fail-closed: file and opaque origins are indistinguishable at
  comparison time, so nothing with a `null` serialization is listable.
  Same-document tools are unaffected (exposure is skipped for the owner).
  Decided 2026-09-28 from review.
- Execution re-checks the target document's gates; a target that lost
  eligibility rejects with `UnknownError`. Target-only unload aborts the
  callback signal while the caller still observes `UnknownError`. Decided
  2026-09-28 from review.

## Official layer (WPT `/webmcp`)

The specification's own suite lives in the **web-platform-tests** repository,
under `webmcp/` — not in the proposal repository, which holds only `index.bs`
and prose.

Pinned revision: **`fe52996d4465f23617bce91927bdd58e6ce8f541`**, recorded in
`WPT_SHA` in `packages/playwright/src/wpt.ts`. That WPT commit is
*"[WebMCP] Remove origin-keyed agent cluster requirement"*, committed
2026-09-30 — the same change, on the same day, as `SPEC_VERSION.commit`
`d61d0e6` in the proposal repository. The two halves of the suite move
together, so a run at this revision tests the draft this package claims.

How to obtain it, so it is not rediscovered:

    browse  https://github.com/web-platform-tests/wpt/tree/<SHA>/webmcp
    raw     https://raw.githubusercontent.com/web-platform-tests/wpt/<SHA>/<path>

To move the pin, find the WPT commit whose message names the same change as the
new `SPEC_VERSION.commit`. Do not float the pin to a branch.

Files are fetched at that immutable revision and cached on disk, so a repeat run
is byte-identical. The suite file itself is served unmodified; integration goes
through `resources/testharnessreport.js`, which upstream documents as the file
"intended for vendors to implement code needed to integrate testharness.js tests
with their own test systems".

### Reading a run

`harness status` is the harness's own completion code and reads **0 even when
every subtest fails**. It is not a pass aggregate. The verdict is per subtest.

### Known divergences

`imperative/object-arguments.https.html` asserts that a tool returning the
JavaScript string `"Success"` makes `executeTool` resolve to `"Success"`. The
draft says otherwise: the IDL is `Promise<DOMString>`, and the algorithm
resolves with *"the result of serializing a JavaScript value to a JSON
string"*, which for that value is `"\"Success\""`. **This implementation follows
the draft; the upstream assertion does not.** It belongs upstream as an issue,
not here as a code change. Pinned by a test so it cannot be forgotten.

`imperative/getTools.https.html` fails with an **empty** failure message —
observed, cause not yet established. Do not record it as an expected failure
until someone has read why.

## Expected failures (seed)

Seeded 2026-09-27 from the Edge 156 experimental/master run set. Run sets are
volatile — Chrome runs presently return no results and file counts drift —
so re-verify before quoting any figure.

- `declarative/executeTool-abort` 0/1
- `declarative/executeTool-pseudo-classes` 1/2
- `imperative/executeTool-abort` 1/5
- `imperative/executeTool-events` 0/2
- `tool-activated-event` 0/4
- `declarative/sandboxed-iframe` 0/1
- `exposedTo-defaults-same-origin` 2/4
- `getTools-imperative-annotations` 1/4
- IDL harness 22/22 (Edge only); Firefox and Safari report no results.

A failure not on this list is unexpected and blocks. A listed failure that
starts passing is evidence the draft or the reference browser moved: refresh
the list, note the date, and say which source changed.

### Not yet re-verified against the 2 October 2026 draft

The list above was seeded on 2026-09-27 and has **not** been re-run against the
2 October draft. The draft removed a precondition from `registerTool`,
`getTools` and `executeTool`, so any official test that asserted a refusal under
that precondition should now be expected to *pass*, and those entries need
re-verifying before any conformance figure is quoted. Treat the list as carried
over, not as re-confirmed.

## Upgrade path

When the draft re-dates, `SPEC_VERSION` moves with it in the same commit as
any behavior change, the list above is re-verified, and the release note names
the new draft. The scheduled drift job (`.github/workflows/spec-drift.yml`)
opens an issue when the published document changes; the baseline hash lives in
`.github/spec-drift.sha256`. If the draft looks wrong, that is an upstream
issue, never a rename in the source.
