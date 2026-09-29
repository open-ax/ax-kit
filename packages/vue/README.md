# `@ax-kit/vue`

Lifecycle-native `document.modelContext` bindings for Vue.

Pinned draft: WebMCP Draft Community Group Report, 29 September 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from `@ax-kit/core` and repeated in every release note.

Everything here is ours, not the draft's: the draft defines the
`document.modelContext` surface, while the composable and directive are
conveniences reachable only through this entry so no spec-conformant core
path can observe them.

## Install

```sh
pnpm add @ax-kit/vue
```

Requires Vue 3.4 or later as a peer. Zero runtime dependencies.

## Use

```vue
<script setup lang="ts">
import { reactive } from "vue";
import { useAxTool } from "@ax-kit/vue";

const tool = reactive({
  name: "viewCart",
  description: "Return the current cart contents.",
  execute: async () => ({ items: [] }),
});

useAxTool(tool);
</script>
```

Setup builds only the inert handle plus guard; registration lives in the
client mount hook with teardown aborting it, so availability tracks
component lifetime. Pass a reactive descriptor when the tool identity
(name, description, input schema) changes at runtime; the binding aborts
then registers with tolerance for transient duplicate-name rejection.
The registered callback forwards through a latest-handler mailbox, and
registration versus execution signals stay distinct.

For plain elements, the directive covers the same lifecycle without
component boilerplate. Handler-only updates forward through the
latest-handler mailbox without re-registering; identity changes abort then
register:

```vue
<script setup lang="ts">
import { vAxTool } from "@ax-kit/vue";

const search = {
  name: "searchProducts",
  description: "Search the catalog.",
  execute: async () => [],
};
</script>

<template>
  <div v-ax-tool="search"></div>
</template>
```

The directive targets plain elements only; component-level tools use the
composable. Server output contributes no tool attributes.
