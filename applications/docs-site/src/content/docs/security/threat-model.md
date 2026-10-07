---
draft: false
title: "Threat model"
description: "What this library can reach, what an agent can do through it, what a page author is exposed to, and what it deliberately does not defend against."
---

This page is written so a security reviewer can assess the library **without
reading its source**. Every claim below is either a behaviour you can verify by
running the [live demonstration](/try-it/), or a link to a public primary source.

## What this library is

It defines `document.modelContext` on one document and holds a registry of tools
that page code registers. An agent present in that document can enumerate those
tools and invoke them.

That is the whole of it. There is no network client, no server, no storage, no
telemetry, and no account. It cannot reach anything the calling page cannot
already reach, because it runs inside the page's own realm.

## What the library can reach

| | |
|---|---|
| The document it was installed on | Registers tools, enumerates them, invokes them |
| Tools registered by page code | Only those, and only while the registration signal is live |
| Anything else | Nothing |

The registry is a `WeakMap` held inside the installed script, keyed by document.
It is not shared with any other document, so a parent frame and a child frame
each hold their own. That is a real gap against the specification — see
[known gaps](./reference/conformance/) — and it happens to be a narrowing one:
a frame cannot see a parent's tools.

## What an agent can do through it

An agent that can call `document.modelContext.executeTool` can do whatever the
**page's own handlers** do. The library does not widen that and does not narrow
it.

- The arguments an agent sends are `unknown` until the page validates them. The
  library passes them through unvalidated, because the specification's
  `inputSchema` is a declared contract and the page owns the checking.
- The result is whatever the page's handler returns, JSON-serialized.
- Cancellation is cooperative: aborting the execution signal tells the page's
  handler to stop, through the `signal` the callback receives. A handler that
  ignores it keeps running.

**The security boundary is the page author's handler, not this library.** A tool
whose handler deletes the user's files would let an agent call it. That is not a
defect in the polyfill; it is the shape of the proposal, and the reason
`consequentialHint` exists as a declaration a page author applies to their own
tool.

## What a page author is exposed to

**Tool output is untrusted content.** A tool whose result contains
model-generated text, or anything a user typed, is content the agent must treat
as untrusted. The library delivers the `untrustedContentHint` annotation and
cannot enforce what a consumer does with it — there is no mechanism in the draft
that constrains a caller's handling of a result.

**An agent can invoke any registered tool.** The `tools` Permissions Policy
feature gates whether the surface exists at all for a document; it does not gate
individual tools. Per-tool restriction is `exposedTo`, which limits *which
origins* may see and invoke a tool, not *who*.

**Anything the page already exposes to same-origin script, it now also exposes
to an agent.** If a same-origin third-party script could call your handler, an
agent can now discover it through the surface. This is the single most
under-appreciated consequence of adding a tool surface, and it is why the
default exposure is same-origin and not "anything present".

## What this library deliberately does not defend against

| Not defended | Why |
|---|---|
| A malicious tool handler | The handler is page code. The library runs in its realm and cannot constrain it. |
| A compromised page origin | Same-origin script already has the page. A tool surface adds discovery, not capability. |
| An agent that ignores `consequentialHint` | The annotation is a declaration. Nothing in the draft makes it enforceable, and inventing enforcement would be a name the proposal does not define. |
| Cross-document tool discovery | Not implemented, and not attempted. Tools do not cross document boundaries in this implementation. |
| Prompt injection through tool results | A property of the agent, not of the transport. The library hands results over; what an agent does with them is outside its reach. |
| A browser that misenforces Permissions Policy | The library reads the policy where observable and assumes allowed where not. [Errors → preconditions](./reference/errors/) describes that limit precisely. |

## Isolation, stated precisely

The library does **not** use a separate world, an isolated realm, or a sandbox of
any kind. It runs in the page's own realm and defines an own, non-writable,
non-configurable data property on the document instance.

- **Why an own property, not a prototype accessor.** The draft's IDL reads
  `partial interface Document { readonly attribute ModelContext modelContext }`,
  which is an accessor on `Document.prototype`. An own property on the instance is
  observably different: a prototype accessor would be reachable from a document
  the bundle never ran against. This is recorded as a known gap rather than
  presented as conformance.
- **Why non-writable and non-configurable.** Hardening against naive shadowing.
  It is **not** a browser-enforced boundary and the library does not claim it is.
  A determined script in the same realm can still shadow it by defining its own
  property on a child object.

## Execution order is not a control

"It has not run yet" is not a security boundary, and this library does not rely
on one. It installs where you tell it to, and any reference obtained later wins.
Back/forward-cache and prerestore paths exist, and other scripts on the page run
first. Ordering is an optimisation; it is never a control.

## Reporting

See [Reporting a vulnerability](/security/reporting/). Private reporting is enabled on
the repository, and the route is served in the standard machine-readable form at
`/.well-known/security.txt`.