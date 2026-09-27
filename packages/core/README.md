# `@ax-kit/core`

A correct, tiny, dependency-free `document.modelContext` implementation for
pages that offer agents a typed capability surface.

Pinned draft: WebMCP Draft Community Group Report, 26 September 2026, from
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
import "@ax-kit/core";

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
- Imperative tools only. The draft's declarative section is a TODO, so there
  is nothing to conform to yet.
- The context property is defined non-writable and non-configurable as
  hardening against naive shadowing, not as a browser-enforced boundary.

## Opt-in conveniences

`@ax-kit/core/ax` holds helpers that are ours, not the draft's: synchronous
`unregisterTool`, single-name `getTool`, parsed-result `executeToolResult`,
and diff-detail `trackToolChanges`. Importing the root entry never exposes
them, so a conformance run cannot observe them.
