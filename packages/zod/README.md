# `@ax-kit/zod`

Validation-library to input-schema conversion for `document.modelContext` tools.

Pinned draft: WebMCP Draft Community Group Report, 29 September 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from `@ax-kit/core` and repeated in every release note.

Everything here is ours, not the draft's: the draft defines the input
schema shape, while this entry converts author-written schemas into it so
the dependency-free core never installs a validation library.

## Use

```ts
import { z } from "zod";
import { convertToInputSchema } from "@ax-kit/zod";

const inputSchema = convertToInputSchema({
	toJSONSchema: (options?: unknown) => z.toJSONSchema(
		z.object({ query: z.string(), maxPrice: z.number().optional() }),
		{ io: "input", ...(options as Record<string, unknown> | undefined) },
	),
});

await document.modelContext.registerTool({
	name: "searchProducts",
	description: "Search the catalog by query and ceiling price.",
	inputSchema,
	execute: async (inputObject) => searchCatalog(inputObject),
});
```

Thin wrapper over the first-party `z.toJSONSchema()` conversion with
registry metadata flowing into the output. Emits the specified input
schema shape with stringify at the boundary, dangerous-key rejection at
any depth, unexpected-property policy, and depth, key-count, and size
caps. Optionally exposes the standard JSON-Schema converter shape
alongside raw emission.
