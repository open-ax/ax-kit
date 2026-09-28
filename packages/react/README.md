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

import { AxProvider, useAxTool } from "@ax-kit/react";

function CartTools({ total }: { total: number }) {
  useAxTool({
    name: "viewCart",
    description: "Return the current cart contents.",
    execute: async () => ({ total }),
  });
  useAxTool("proceedToCheckout", async () => ({ ok: true }), {
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

## Dispatch

`dispatchAxClick` drives one click against a React-managed node as a
fallback-wrapped enhancement over native dispatch: it invokes the nearest
enclosing `onClick` with a synthesized event carrying the real target, and
falls back to native bubbling dispatch where the enhancement is missing.
Click-only and single-handler by design — capture handlers, other event
types, and further ancestors never run through the bridge. Disabled form
controls skip the bridge and use native dispatch, which correctly performs
no action — including controls disabled by an ancestor `fieldset`. The synthesized event carries `type`, bubbling flags, the real
target, and a usable `nativeEvent`. Bridge failure
never rejects an invocation native dispatch could complete, a bridged
handler that throws is reported without a native re-run, and fallback use
is logged. Plain nodes use native dispatch with no bridge. The native path
uses the prototype-chain `click`, never a page-owned expando.

```tsx
import { dispatchAxClick } from "@ax-kit/react";

dispatchAxClick(document.querySelector("button") as Element);
```
