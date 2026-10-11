---
draft: false
title: "Security whitepaper"
description: "Every claim traced to a public primary source and every divergence from the current draft stated rather than omitted."
---

This is written, not copied. Every citation below was opened at the point of
writing. Each one is linked so you can check it rather than take it on trust.

The [threat model](/security/threat-model/) covers what the library can reach. This page
covers the web platform mechanisms it relies on. The part most whitepapers
skip: **where this implementation diverges from the current draft**.

## The platform mechanisms it relies on

### Permissions Policy

The tool surface is gated behind a feature policy. A document that does not
declare it in `tools` cannot use a tool surface at all.

Source: [W3C Permissions Policy](https://www.w3.org/TR/permissions-policy-1/) ·
[MDN `Permissions-Policy`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy)

**What this implementation does.** Reads `document.permissionsPolicy` where the
API is present and refuses where the feature is *observed* to be denied. Where the
API is absent, it assumes allowed and lets the browser enforce denial.

**The limit, stated rather than omitted.** `allowsFeature()` reports `false` for
an unknown feature as well as a denied one, so the two are indistinguishable
through that call alone. This implementation consults the feature list first and
treats `false` as a denial only when the list actually names `tools`. Outside an
origin trial, Chromium logs *"Origin trial controlled feature not enabled"* for
the feature and then reports it as **absent rather than denied**, which is why
the default is to assume allowed. Where the browser denies the feature itself, the
surface is useless anyway, because the platform enforces it independently of any
script.

Measured: Chromium 153.0.8010.12, running the page with `tools=(self)` declared,
logs that warning and still serves the surface.

### Secure contexts

The draft marks `modelContext` `[SecureContext]`.

Source: [MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) ·
[W3C Secure Contexts](https://w3c.github.io/webappsec-secure-contexts/)

Installation returns `undefined` in a non-secure context. A polyfill cannot
override the platform's determination of what is a secure context, so this is one
of the few gates that is genuinely the browser's decision.

### Cross-document isolation

The draft requires `getTools()` to resolve to tools "from this document and its
descendants". Each document that evaluates the bundle holds its own registry, so
**this implementation does not do that** and does not attempt it.

Source: [MDN Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy)

This is recorded as the largest known gap in
[conformance](/reference/conformance/). It is a *narrowing* divergence: a frame
sees fewer tools than the specification grants, never more.

### JSON serialization of tool results

`executeTool` resolves to `Promise<DOMString>` over a JSON serialization of the
handler's return value.

Source: [WebMCP draft](https://webmachinelearning.github.io/webmcp/) ·
[ECMA-262 JSON.stringify](https://tc39.es/ecma262/#sec-json.stringify)

A handler returning the JavaScript string `"Success"` therefore produces the
nine-character string `"\"Success\""`. The upstream test suite asserts against the
unencoded value, which **contradicts the draft's own text**; this implementation
encodes, which follows the draft. The upstream test is listed as an
`upstream-gap` in the expected-failure file. The fix belongs in the proposal.

## Divergences from the current draft

Stated here because a library that behaves differently from the specification, in
a way it can defend, is more useful to an adopter than one that hides it.

| Divergence | Direction | Why |
|---|---|---|
| Tools do not cross document boundaries | Narrowing | Each document's registry is its own. Largest known gap; causes most expected failures. |
| `ModelContext`, `ToolActivatedEvent`, `ToolCancelEvent` are not global constructors | Narrowing | The behaviour the event tests assert is implemented; the named interface objects are not exposed. |
| `modelContext` is an own property, not a `Document.prototype` accessor | Narrowing | An own property is not reachable from a document the bundle never ran against. |
| `SecurityError` on non-origin-keyed agent cluster | **Removed** | Upstream PR #330 removed the requirement on 2026-09-30; this implementation follows the 2 October 2026 draft. |
| Arguments are checked against `inputSchema` before the handler runs | Narrowing | The draft declares `inputSchema` and implements no checking against it. This library validates first and rejects with `UnknownError`, so an agent cannot reach a handler with arguments the schema forbids. |

## What the library does not do

- It opens no network connections. It makes no requests of any kind.
- It stores nothing. The registry is in-memory and dies with the document.
- It sets no cookies and reads none.
- It collects no telemetry and has no analytics.
- It does not touch native prototypes. `Object.prototype` and `Window.prototype`
  are unmodified.
- It adds no globals except the `document.modelContext` property it is asked to
  define and the two event classes the package exports for pages that want them.

## Supply chain

Zero runtime dependencies in the polyfill package, asserted in CI as a build
failure. `StandardSchemaV1` is consumed **structurally**: the interface is
declared locally rather than installed, so no validation library reaches a
consumer's bundle through this package.

The ESM entry is measured against a 5 kB gzip budget in the same CI run. The
budget is a hard failure, not a README sentence. Raising it to make a build
pass is not an accepted fix.

## Verifying these claims

The conformance suite runs on every change as a required status check on all
three engines. [Conformance](/reference/conformance/) states what is measured,
what is excluded, what is expected to fail and the reason for each.

To verify the behavioural claims yourself, the [live demonstration](/try-it/)
runs in your browser against the published entry points.