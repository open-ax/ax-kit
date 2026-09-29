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

test("surface exists before app code", async ({ page }) => {
  await page.goto("about:blank");
  await expect(page.ax.isInstalled()).resolves.toBe(true);
});
```

The overriding `page` fixture installs exactly one init script carrying the
built bundle before any test navigation, attaches the runner-realm companion
as `page.ax`, yields the page, and disposes the init-script handle on
teardown. No helper enters the page namespace besides the typed surface
itself, so page script cannot observe, shadow, or collide with the companion.

## Notes

- The companion lives in the test process. Only serializable data crosses
  the evaluate boundary; handles never cross, names cross instead.
- The change signal is treated as a re-list hint with no ordering promise;
  consumers re-list on every wake.
- Listings sort ascending by name in code-unit order and match by name,
  never by position.
