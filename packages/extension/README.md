# `@ax-kit/extension`

Worker-side bridge driving `document.modelContext` from a service worker.

Pinned draft: WebMCP Draft Community Group Report, 29 September 2026, from
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
	authorizeExecution,
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
disagree.

If a person was asked about one invocation and a different one arrives for
the same tool on the same tab, the answer is **refusal**. Re-prompting would
train a person to click through, which defeats the control.

The manifest defaults deny external connections, keep private browsing
closed, and flag broad host scope with a review justification. Only the
permissions the worker reads are requested. The audit trail is written by the
worker into page-unreachable storage: local log only, with no integrity
guarantee until shipped off-machine.

## Exposure

A tool is exposed to its own origin and to nothing else. The draft also lets a
definition widen itself with `exposedTo`, and the registered-tool listing this
package reads does not carry that set, so the worker has none to honour and
admits the page's own origin only — the draft's default.

The allow-list is deliberately never taken from the request. A caller that
supplies both the allowed set and the identity being checked against it always
agrees with itself, so it would grant itself whatever it asked for. Widening
this needs the declared set to reach the worker, not a caller to supply it.

## To consume the policy helpers

The library entry point is unchanged and additive:
