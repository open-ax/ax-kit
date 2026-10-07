# `@ax-kit/core`

A correct, tiny, dependency-free `document.modelContext` implementation for
pages that offer agents a typed capability surface.

Pinned draft: WebMCP Draft Community Group Report, 2 October 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from this package and repeated in every release note, so no
review happens against an unnamed draft. The draft is not a W3C Standard and
is not on the Standards Track.

What conformance means here, and what happens when the draft re-dates, is
described in `../../docs/conformance-baseline.md`.

## Install

```sh
pnpm add @ax-kit/core
```

Zero runtime dependencies. The ESM entry stays at or under 5 KB gzipped; the
build fails if it grows past that.

## Use

```js
import { installModelContext } from "@ax-kit/core";

installModelContext(document);

await document.modelContext.registerTool({
	name: "search_products",
	description: "Search the catalog by query and ceiling price.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string" },
			maxPrice: { type: "number" },
		},
		required: ["query"],
	},
	execute: async (inputObject) => {
		const items = await searchCatalog(inputObject);
		return items;
	},
});

const tools = await document.modelContext.getTools();
const tool = tools.find((entry) => entry.name === "search_products");
if (tool !== undefined) {
	const json = await document.modelContext.executeTool(tool, { query: "lamp" });
	console.log(JSON.parse(json));
}
```

`registerTool`, `getTools`, and `executeTool` are async and reject with the
draft's error names (`InvalidStateError`, `SecurityError`, `NotAllowedError`,
`NotSupportedError`, `UnknownError`, `TypeError`). Removal is via the
registration signal: aborting it unregisters the tool without settling
in-flight calls. One signal per concern: the registration signal controls
availability, the execution signal cancels one call.

Notes on scope:

- `document` only. There is no `window` or `navigator` alias on any entry.
  Installation is explicit per document: call `installModelContext(document)`
  once setup runs. The root and `/ax` entries have no import side effects, so
  bundlers can tree-shake them honestly. The one exception is
  [`@ax-kit/core/auto`](#auto-installing), which installs on import and says so
  in its `sideEffects` field.
- Imperative tools only. The draft's declarative section is a TODO, so there
  is nothing to conform to yet.
- The context property is defined non-writable and non-configurable as
  hardening against naive shadowing, not as a browser-enforced boundary.
- The `untrustedContentHint` annotation is stored and surfaced on listing;
  honoring it in handling belongs to the calling agent. The polyfill delivers
  the annotation but cannot enforce how a consumer treats output.
- Opt-out (`Permissions-Policy: tools=()`) is honored whenever observable
  through the Permissions Policy API: installation refuses and calls reject.
  Removing the feature before scripts run is enforced by the browser
  delivering the header, which a polyfill can neither pre-empt nor defeat.

## Opt-in conveniences

`@ax-kit/core/ax` holds helpers that are ours, not the draft's: synchronous
`unregisterTool`, single-name `getTool`, parsed-result `executeToolResult`,
and diff-detail `trackToolChanges`. Importing the root entry never exposes
them, so a conformance run cannot observe them.

## Auto-installing

`@ax-kit/core/auto` installs the surface against the ambient document when you
import it. It exists for one situation: a server-rendered application, where the
page itself renders on the server and an explicit install call has no client-side
place to be written from.

```ts
"use client";

import { useEffect } from "react";
import { autoInstallModelContext } from "@ax-kit/core/auto";

// Mounted as the first child of the document body.
export function Polyfill() {
  useEffect(() => {
    autoInstallModelContext();
  }, []);
  return null;
}
```

**When the install runs depends on the framework, and it is worth knowing which
you have.** Some frameworks have a client entry module that is evaluated before
hydration; importing `/auto` there does what the name suggests. The Next.js App
Router has no such hook — its closest equivalents, `instrumentation.ts` and the
App Router's own entry points, run on the server and never touch the reader's
document. In that framework the import above runs *after hydration begins*, which
means there is a window in which an agent arriving early finds no surface. There
is no arrangement that removes that window; marking the whole tree as a client
component to get an earlier install throws away the server rendering that was the
reason for using `/auto` at all.

Registering the tools has the same constraint, for a different reason. A Server
Component cannot hand an ordinary function to a Client Component — the props are
serialized, and a function is not serializable — so the registration call belongs
in an effect inside a client component, not in a prop passed down from the server:

```ts
"use client";

import { useEffect } from "react";
import { autoInstallModelContext } from "@ax-kit/core/auto";
import { registerStorefrontTools } from "./tools";

export function ToolRegistration() {
  useEffect(() => {
    // `autoInstallModelContext` returns `undefined` when the surface already
    // exists — including when `/auto` installed it on import earlier, which is
    // the normal case here. Reading `document.modelContext` as the fallback is
    // what makes the two components composable: `Polyfill` may mount, or not, and
    // this one works either way.
    //
    // A genuine refusal also leaves it `undefined`, and that is still the right
    // answer: nothing to register against.
    const context =
      autoInstallModelContext() ??
      (document as unknown as Record<string, unknown>).modelContext;
    if (context === undefined || context === null) return;

    let dispose: (() => void) | undefined;
    let cancelled = false;
    void Promise.resolve(registerStorefrontTools(context)).then((remove) => {
      // Cleanup can run while registration is still in flight, so the disposer is
      // kept and called on both paths. Dropping it leaves the tools registered
      // after unmount, and a remount collides on the names.
      dispose = remove;
      if (cancelled) remove();
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  return null;
}
```

Importing it performs no work where there is no `document`, so it is safe in an
environment that renders on a server. Importing it again does nothing: an
existing native or polyfilled `document.modelContext` is preserved rather than
replaced, because a polyfill that overwrites a native implementation makes the
platform look broken.

It is a separate entry point rather than part of the root one, and separately for
bytes. The root entry is measured against a hard 5 KB gzip budget with very
little headroom, and an install-on-import side effect is opt-in behaviour a
conformant consumer has no reason to pay for.

Installation is refused, not thrown, in an insecure context or where the `tools`
Permissions Policy feature is denied.

**Check for the surface before using it.** A refusal leaves no property behind, so
`document.modelContext.registerTool(…)` is a `TypeError` on `undefined` — a plain
JavaScript error thrown *before* any draft method runs, not one of the specified
names. The draft's error taxonomy covers calls that reach an installed surface, so
a caller that has not checked should not expect to see it:

```ts
import "@ax-kit/core/auto";

const context = document.modelContext;
if (context === undefined) {
	// No surface: an insecure context, or a denied `tools` policy. The page
	// still works — a tool surface is additive, not required to use the site.
} else {
	await context.registerTool(tool);
}
```

For the same reason, `autoInstallModelContext()` resolves to `undefined` both when
it refused and when there was already a surface to preserve. Reading
`document.modelContext` is what tells those two apart.
