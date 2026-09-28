# `@ax-kit/react`

Lifecycle-native `document.modelContext` bindings for React.

Pinned draft: WebMCP Draft Community Group Report, 26 September 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from `@ax-kit/core` and repeated in every release note.

Everything here is ours, not the draft's: the draft defines the
`document.modelContext` surface, while these hooks and the provider are
conveniences reachable only through this entry so no spec-conformant core
path can observe them.

## Install

```sh
pnpm add @ax-kit/react
```

Requires React 18 or 19 as a peer. Zero runtime dependencies.

## Use

```tsx
"use client";

import { AxProvider, useAxAction, useAxTool } from "@ax-kit/react";

function CartTools({ total }: { total: number }) {
  useAxTool({
    name: "viewCart",
    description: "Return the current cart contents.",
    execute: async () => ({ total }),
  });
  useAxAction("proceedToCheckout", async () => ({ ok: true }), {
    description: "Start checkout.",
    annotations: { consequentialHint: true },
  });
  return null;
}

export function Page({ total }: { total: number }) {
  return (
    <AxProvider namespace="cart." middleware={async (next, args, opts) => next(args, opts)}>
      <CartTools total={total} />
    </AxProvider>
  );
}
```

Registration is deferred to the client effect with the controller created
inside it and aborted in cleanup, so StrictMode setup-cleanup-setup leaves
exactly one registration. Server render access returns an inert handle where
`window` is absent, and modules using the hooks carry `"use client"`.
The registered callback forwards to a latest-handler mailbox while identity
change aborts then registers with tolerance for transient duplicate-name
rejection. Registration and execution signals stay distinct.
