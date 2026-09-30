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
const key = store.requestApproval(
	{
		key: createHitlKey({
			tabId: 1,
			documentId: "doc-1",
			frameId: 0,
			toolName: "proceedToCheckout",
			argsHash: hashArgs(argsJson),
		}),
		toolName: "proceedToCheckout",
		origin: "https://shop.example",
		frameOrigin: "https://shop.example",
		argsJson,
		consequentialHint: true,
		readOnlyHint: false,
		definitionVersion: "v1",
	},
	true,
);
```

Traffic travels as request/response injection from the service worker with
the result returned directly to the calling extension context. There is no
DOM event bus, no page-visible channel, and no handshake event. Handlers
are enumerated (`listTools`, `getTool`, `executeTool`) and self-contained;
unknown names are unreachable by construction.

Confirmation renders in the side panel only, bound to tab, document,
frame, tool name, and argument hash, with all five re-verified at
execution. Approvals are single-use and gesture-initiated; a definition
change invalidates the pending entry. The manifest defaults deny external
connections, keep private browsing closed, and flag broad host scope with
a review justification. The audit trail is written by the worker into
page-unreachable storage: local log only, with no integrity guarantee
until shipped off-machine.
