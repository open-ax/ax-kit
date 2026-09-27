# Conformance baseline

Conformance here means one thing: zero unexpected failures against the pinned
draft named below. It never means blanket green, because the reference browser
itself does not pass the whole official suite.

Pinned draft: WebMCP Draft Community Group Report, 26 September 2026
(upstream `729ae01`), exported as `SPEC_VERSION` from `@ax-kit/core`.

## Layers

- Fast layer (`happy-dom`): pure logic — name validation, schema rejection,
  serialization edges, sorting, gate wiring.
- Browser layer (real Chromium via Vitest Browser Mode): everything touching
  `document.modelContext` — `EventTarget` semantics, `AbortSignal` races, the
  error taxonomy, Permissions Policy gating, origin logic, per-frame
  isolation. Run with `pnpm test`; the `chromium` project needs a Playwright
  Chromium install (`pnpm exec playwright install chromium`).
- Official layer (WPT `/webmcp`): the specification's own suite. The signal is
  the diff against the expected-failure list, not the raw count.

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

## Upgrade path

When the draft re-dates, `SPEC_VERSION` moves with it in the same commit as
any behavior change, the list above is re-verified, and the release note names
the new draft. The scheduled drift job (`.github/workflows/spec-drift.yml`)
opens an issue when the published document changes; the baseline hash lives in
`.github/spec-drift.sha256`. If the draft looks wrong, that is an upstream
issue, never a rename in the source.
