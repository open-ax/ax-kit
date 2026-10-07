# ax-kit reference storefront

A small shop that publishes its capabilities as typed tools. It exists to be
copied, so it is written to be read in one sitting and every file says why it is
arranged the way it is.

```sh
pnpm --filter @ax-kit/demo-store dev     # http://localhost:3000
pnpm --filter @ax-kit/demo-store build
pnpm --filter @ax-kit/demo-store test            # the tool surface, fast layer
pnpm --filter @ax-kit/demo-store test:browser    # the built output, real browser
```

## What it demonstrates

| | |
|---|---|
| `search_products({ query, maxPrice? })` | a tool with an optional argument |
| `view_cart()` | a tool that takes no arguments |
| `add_to_cart({ sku, quantity })` | a mutation, **not** consequential |
| `apply_coupon_code({ code })` | a mutation, **not** consequential |
| `proceed_to_checkout()` | **consequential** — spends money, cannot be undone |

Those names and argument shapes are canonical. They appear identically here, in
the documentation, and in every example in this project, and a test asserts the
storefront's page and its tool table agree.

## The three things worth copying

**The consequential annotation is argued, not chosen by feel.** Only
`proceed_to_checkout` carries `consequentialHint`, because it is the only
irreversible one. The two cart mutations are deliberately *not* annotated: both
are reversible, neither costs anything, and a user who clicked "add to cart" has
already confirmed it. Over-annotating trains agents and users to dismiss
confirmations, which is the exact failure mode the annotation exists to prevent.
The reasoning is in `src/lib/tools.ts` where a reader will actually see it.

**Arguments are validated against the declared schema before any handler runs.**
The draft's `inputSchema` is a declared contract; validating against it is this
project's job, because a polyfill is the thing doing the validating. The
declaration and the check are written from one table so they cannot drift apart.

One consequence worth knowing: the draft specifies that a callback which throws
rejects the caller with `UnknownError`, so the readable message a handler throws
is *not* what an agent sees. See `buildTool` in `src/lib/register.ts`.

**The polyfill installs without the tree becoming client-side.** `layout.tsx`,
`page.tsx` and `storefront.tsx` are server components, and the catalogue, the
copy and the structured data are in the server's output. Exactly two components
carry `"use client"`.

## The honest parts

- **It is not deployed.** `pnpm build && pnpm start` is what the tests run
  against; there is no deployment here, and the site cannot claim otherwise.
- **No commerce protocol is implemented.** AP2, ACP and Merchant Checkout are
  each early enough that a small example speaking one would be speaking a draft.
  The page says so, `/agent-profile.json` declares `supports_ap2: false` and
  `supports_acp: false`, and `/api/catalog` answers **501** rather than serving a
  well-formed body that a reader might mistake for support.
- **The install is a client component, not a client entry hook.** Next.js's App
  Router has no `client.js` convention, and `instrumentation.ts` runs on the
  *server*. `src/app/install-polyfill.tsx` explains what that costs — the install
  happens after hydration begins rather than before it.
- **Tools are per-document, so a frame or a popup sees nothing.** That is the
  largest known gap in this implementation and it is recorded in
  `docs/conformance-baseline.md`.

## Deployment

The permission policy is declared in `next.config.ts` and asserted against a real
served response:

```
Permissions-Policy: tools=(self)
```

Without it the page works on localhost and silently does nothing anywhere else,
because the platform treats loopback as potentially trustworthy. That is the
single most common way an example like this misleads, so it is declared in the
build rather than in a README.