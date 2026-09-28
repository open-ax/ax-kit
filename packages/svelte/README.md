# `@ax-kit/svelte`

Lifecycle-native `document.modelContext` bindings for Svelte.

Pinned draft: WebMCP Draft Community Group Report, 26 September 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from `@ax-kit/core` and repeated in every release note.

Everything here is ours, not the draft's: the draft defines the
`document.modelContext` surface, while the element binding and rune helper
are conveniences reachable only through this entry so no spec-conformant
core path can observe them.

## Install

```sh
pnpm add @ax-kit/svelte
```

Requires Svelte 5 or later as a peer. Zero runtime dependencies.

## Use

Element binding with `update` plus `destroy` teardown:

```svelte
<script>
  import { axTool } from "@ax-kit/svelte";

  const search = {
    name: "searchProducts",
    description: "Search the catalog.",
    execute: async () => [],
  };
</script>

<div use:axTool={search}></div>
```

Rune helper inside `$effect` with returned teardown:

```svelte
<script>
  import { axToolEffect } from "@ax-kit/svelte";

  let desc = $state("Return the cart contents.");

  $effect(() =>
    axToolEffect({
      name: "viewCart",
      description: desc,
      execute: async () => ({ items: [] }),
    }),
  );
</script>
```

One teardown mechanism per binding, never both. Update aborts then
registers while destroy aborts, so re-runs never orphan names. Handler-only
updates forward through the latest-handler mailbox without re-registering.
Reactive values read synchronously retrigger correctly with no state writes
inside the binding. The rune helper registers once per effect run, so a
same-identity handler swap applies on the next reactive re-run. Actions
never run during server rendering, and shared helper paths keep an explicit
guard for universal-module imports.

Attachments were evaluated against Svelte 5.57 at build time: the action
contract above remains supported and typed, and callers preferring
attachments can wrap it with `fromAction(axTool, () => params)` without
a migration.
