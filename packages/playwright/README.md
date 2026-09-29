# `@ax-kit/playwright`

Runner-side companion for driving `document.modelContext` in tests.

Pinned draft: WebMCP Draft Community Group Report, 26 September 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from `@ax-kit/core` and repeated in every release note.

Everything here is ours, not the draft's: the draft defines the
`document.modelContext` surface, while this fixture and companion are
conveniences reachable only through this entry so no spec-conformant core
path can observe them.

## Install

```sh
pnpm add -D @ax-kit/playwright @playwright/test
```

Requires `@playwright/test` 1.63.0 as a peer. The page-side bundle is
installed from this package's `dist`, so build before running tests.

## Use

```ts
import { expect, test } from "@ax-kit/playwright";

test("drives the offered surface", async ({ page }) => {
  await page.goto("/");
  const tools = await page.ax.getAvailableTools();
  expect(tools.map((tool) => tool.name)).toContain("viewCart");
  const cart = await page.ax.executeTool("viewCart", {});
  expect(cart).toEqual({ items: [] });
});
```

The overriding `page` fixture installs exactly one init script carrying the
built bundle before any test navigation, attaches the runner-realm companion
as `page.ax`, yields the page, and disposes the init-script handle on
teardown. No helper enters the page namespace besides the typed surface
itself, so page script cannot observe, shadow, or collide with the companion.
The fixture composes with project-dependency setup, `mergeTests`, and
worker-scoped setup.

## Operations

```ts
await page.ax.getAvailableTools({ fromOrigins?: string[] });
await page.ax.waitForTool(name, { timeout?: number });
await page.ax.expectTool(name, { timeout?: number });
await page.ax.executeTool<T>(name, args?, { signal?: AbortSignal });
```

- `getAvailableTools` lists the current tools sorted ascending by name in
  code-unit order, with origin scoping and annotations preserved. The live
  `window` field never crosses the boundary; use the returned names.
- `waitForTool` checks the current listing first and resolves at once on a
  hit, otherwise waits on the in-page change hint with an in-page guard.
  Every wake re-lists and matches by name, looping to the deadline on
  unrelated registrations. The default timeout follows the runner's
  assertion default of 5 seconds and a miss rejects with a `TimeoutError`
  naming the tool.
- `expectTool` polls the same listing through the runner's retrying
  primitive with the same matcher, forwarding the given timeout options.
  A miss rejects with a `TimeoutError` naming the tool, matching
  `waitForTool`. Listing failures other than a miss propagate unchanged.
- `executeTool` resolves the name to a fresh handle inside the page on
  every call, passes arguments as serializable data only, and parses the
  specified string result at the companion boundary. A result outside
  JSON rejects with a typed `AxParseError` carrying the tool name and the
  raw text. A passed `signal` abandons the runner-side wait without
  unregistering the tool; availability and execution stay on distinct
  lifetimes.

## Errors

Draft rejection families propagate unchanged: duplicate or malformed
names reject with `InvalidStateError`, non-object arguments with
`TypeError`, unknown tools at call time with `UnknownError`, and the
remaining gates (inactive document, origin-keyed cluster, denied feature,
untrustworthy origin entries, opaque origin) with their specified names.
A missing installation fails fast with a typed `AxMissingSurfaceError`
instead of passing silently.

## Notes

- The companion lives in the test process. Only serializable data crosses
  the evaluate boundary; handles never cross, names cross instead, and
  every page function is self-contained with no closed-over state.
- The change signal is treated as a re-list hint with no ordering promise;
  consumers re-list on every wake.
- Listings sort ascending by name in code-unit order and match by name,
  never by position. Each frame evaluates its own bundle copy, so listings
  are frame-local and cross-origin tools never leak into the top document.
- There is no sleep-based waiting anywhere: bounded waits ride the change
  hint or the retrying assertion, and the DOM-shuffling gate harness that
  proves it lives in `test/` only, never in the published entry.
