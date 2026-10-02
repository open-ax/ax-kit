# `@ax-kit/cli`

In-page contract audit for `document.modelContext` under headless Chromium.

Pinned draft: WebMCP Draft Community Group Report, 29 September 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from `@ax-kit/core` and repeated in every release note.

Everything here is ours, not the draft's: the draft defines the page
surface, while this command grades how well one page uses it.

## Use

```sh
pnpm exec playwright install chromium
ax-kit audit https://shop.example
```

The Chromium that Playwright installs is required before the first run: a
missing browser is reported as a failed command with exit code `1`, not as a
page with no tools. The bundled headless shell is not enough — the audit needs
the full `chromium` binary, which is what loads an extension and what
`channel: "chromium"` resolves to.

The command launches a real headless Chromium, navigates to the URL, collects
the page's actual registered tools from its `document.modelContext`, scores
them, and prints the report. Diagnostics go to standard error, so the report on
standard output stays machine-readable.

Exit code: `0` when nothing failed, `2` when the findings include a failure, `1`
when the command could not run. A page with no tools at all is reported
distinctly from a page whose tools are undiscoverable, so you can tell which
problem you have.

Scores typed tools, schema validity, consequential coverage, read-only
sanity, exposure discipline, character budgets (500/150/30/1.5K),
feature-policy posture, and the origin-keyed cluster precondition.

In-page contract audit: edge sees discoverability, journey agents see
behavior, this audit sees the in-page contract. Never an unqualified
readiness score.

## Programmatic use

The driver is exported so a caller can audit with its own browser options, and
the pure scorer stays separately importable:

```ts
import { auditLiveUrl, exitCodeFor, scoreAudit } from "@ax-kit/cli";

const { report, context } = await auditLiveUrl(
  { headless: true },
  "https://shop.example",
);
process.stdout.write(report);
process.exitCode = exitCodeFor(context);
```
