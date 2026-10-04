# `@ax-kit/extension`

Worker-side bridge driving `document.modelContext` from a service worker.

Pinned draft: WebMCP Draft Community Group Report, 2 October 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from `@ax-kit/core` and repeated in every release note.

Everything here is ours, not the draft's: the draft defines the page
surface, while this entry holds the worker transport, confirmation binding,
manifest posture, and audit trail so no spec-conformant core path can
observe them.

## Use

```ts
import {
	ApprovalStore,
	TRANSPORT_KIND,
	canonicalizeArgs,
	createHitlKey,
	createInjectionRequest,
	defaultManifestPosture,
	hashArgs,
} from "@ax-kit/extension";

const request = createInjectionRequest("executeTool", { sku: "lamp-01" });
console.log(TRANSPORT_KIND, request.handler);

const store = new ApprovalStore();
const argsJson = canonicalizeArgs({ sku: "lamp-01" });
const key = store.requestApproval({
	key: createHitlKey({
		tabId: 1,
		documentId: "doc-1",
		frameId: 0,
		toolName: "proceedToCheckout",
		argsHash: hashArgs(argsJson),
	}),
	toolName: "proceedToCheckout",
	description: "Charge the saved card.",
	origin: "https://shop.example",
	frameOrigin: "https://shop.example",
	argsJson,
	consequentialHint: true,
	readOnlyHint: false,
	definitionVersion: "v1",
});
```

Traffic travels as request/response injection from the service worker with
the result returned directly to the calling extension context. There is no
DOM event bus, no page-visible channel, and no handshake event. Handlers
are enumerated (`listTools`, `getTool`, `executeTool`) and self-contained;
unknown names are unreachable by construction.

## Loading it

The policy functions below are worth consuming directly, and the package is
also loadable as an extension.

The package emits a loadable unpacked directory:

```sh
pnpm --filter @ax-kit/extension build
```

That writes `dist/unpacked/` — `manifest.json`, `sw.js`, `panel.html`,
`panel.js`. Load it in Chrome with "Load unpacked", or point a browser at it
directly:

```sh
chromium --load-extension=packages/extension/dist/unpacked
```

The manifest is written by the same posture function the assertions read, so the
emitted file cannot describe an intention the code does not hold. Note that
headless Chrome resolves to a shell that loads no extension; use the full
browser binary.

## Confirmation

Confirmation renders in the side panel only, bound to tab, document,
frame, tool name, and argument hash, with all five re-verified at
execution. Approvals are single-use; a definition change invalidates the
pending entry. The version covers every field the person reads — the name,
the description, the annotations, and the input schema — so a page that
changes what it says a tool does loses the approval given to the old words.

The worker files the confirmation itself, from the tool view it validated,
when a consequential tool is invoked. Nothing outside the worker can raise
one: a caller cannot put text of its own choosing in front of a person as
though the page had written it. Filing raises the question and grants
nothing — the answer is `approve`, which only the panel's own click reaches.

The panel shows the tool name, its description, and the exact arguments, so
the click is informed. It holds no state of its own: every value it renders
comes from the worker, so the panel and the thing that will execute cannot
disagree. A decision carries the definition version the card displayed, and a
stale card cannot approve a replacement definition it never showed.

If a person was asked about one invocation and a different one arrives for
the same tool on the same tab, the answer is **refusal**. Re-prompting would
train a person to click through, which defeats the control.

The manifest defaults deny external connections, keep private browsing
closed, and flag broad host scope with a review justification. Only the
permissions the worker reads are requested.

Pending approvals and the audit trail live in the service worker's memory, not
in extension storage. The worker is page-unreachable, so neither is reachable
from a page, and the trail is a local log with no integrity guarantee until it
is shipped off-machine. It does not survive the browser stopping an idle
worker: a pending approval is lost rather than executed, and the panel says so
when a decision arrives for an invocation the worker no longer holds. Making
either durable means writing them to extension storage, which is async and
would put an await on every decision.

## Exposure

A tool is exposed to its own origin and to nothing else. The draft also lets a
definition widen itself with `exposedTo`, and the registered-tool listing this
package reads does not carry that set, so the worker has none to honour.

This is a policy, not an authorisation boundary, and the difference is worth
stating. The *caller origin* still arrives in the request, so a caller names its
own identity here. What removing the caller-supplied allow-list buys is that the
set of origins admitted is no longer something a caller chooses. The manifest
denies external connections, so the callers that can reach the worker are this
extension's own pages. An identity the browser asserts — taken from the message
sender — is what would make this a boundary rather than a narrowing.

## To consume the policy helpers

The library entry point is unchanged and additive:
