# `@ax-kit/cli`

In-page contract audit for `document.modelContext` under headless Chromium.

Pinned draft: WebMCP Draft Community Group Report, 15 October 2026, from
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

The command launches a real headless Chromium, navigates to the URL, waits
for the page's context to appear and for the browser to report that the page
has stopped fetching, collects the page's actual registered tools from its
`document.modelContext`, scores them, and prints the report. Diagnostics go to
standard error, so the report on standard output stays machine-readable.

Exit code: `0` when nothing failed, `2` when the findings include a failure, `1`
when the command could not run. A page with no tools at all is reported
distinctly from a page whose tools are undiscoverable, so you can tell which
problem you have.

Scores typed tools, schema validity, consequential coverage, read-only
sanity, exposure discipline, character budgets (500/150/30/1.5K), and
feature-policy posture.

Every finding carries an enforcement label, and the report counts them:

```
3/12 failing (1 enforced, 2 advisory)
enforced = a failure stops an agent using the page as declared; advisory = quality only, blocks nothing. ...
pass enforced typed viewCart: input schema present and valid
fail advisory description-budget placeOrder: description 612/500
```

`enforced` is the claim that a failure stops an agent doing what the page
declared it could. `advisory` is a judgement about quality that blocks nothing
anywhere. The split was measured rather than chosen — the audit and the shipped
bridge were run against the same pages in the same browser session, and
[`docs/audit-vs-bridge.md`](../../docs/audit-vs-bridge.md) is the record of
where they agree and where they do not.

The exit code counts **every** finding, advisory included. It is a verdict on
the in-page contract, not on what an agent can invoke: a page with a
600-character tool description and no other problem exits `2` and is entirely
invokable. Read the labels, not the code.

In-page contract audit: edge sees discoverability, journey agents see
behavior, this audit sees the in-page contract. Never an unqualified
readiness score.

## Programmatic use

The driver is exported so a caller can audit with its own browser options, and
the pure scorer stays separately importable:

```ts
import { auditLiveUrlFindings, exitCodeFor } from "@ax-kit/cli";

const { report, context } = await auditLiveUrlFindings(
  { headless: true },
  "https://shop.example",
);
process.stdout.write(report);
process.exitCode = exitCodeFor(context);
```

`auditLiveUrlFindings` returns the report and the collected context; the context
is what `exitCodeFor` scores into an exit code. `auditLiveUrl` is the same call
returning only the formatted report, for when the code is not wanted.
