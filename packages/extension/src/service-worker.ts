// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Service-worker entry: the Trusted tier, as something a browser loads.
 *
 * Everything here is ours, not the draft's: the draft defines the page surface,
 * while this worker decides what may execute. Values crossing the Main-world
 * boundary arrive as hostile input and are validated before any decision, and
 * there is no page-visible channel at any point.
 *
 * The injection functions below are serialized by the platform and lose their
 * closures, so each one is self-contained by construction: no imports, no
 * captured variables, no helpers from this module. Anything they need is passed
 * as an argument.
 */

import type { InjectionRequest } from "./handlers.js";
import { assertHandlerName, createInjectionRequest } from "./handlers.js";
import type { HitlKey } from "./hitl.js";
import {
	ApprovalStore,
	canonicalizeArgs,
	createHitlKey,
	hashArgs,
	hitlKeyToString,
} from "./hitl.js";
import { assertLiveContext } from "./manifest.js";
import {
	AUDIT_TRAIL_DISCLAIMER,
	applyArgAllowList,
	isExposedToCaller,
	validateFrameTool,
	WorkerAuditTrail,
} from "./trusted-tier.js";

/**
 * Enumerate the page's tools. Self-contained: the platform serializes this and
 * drops everything it closes over.
 */
async function listToolsInPage(_arg: unknown): Promise<unknown> {
	const doc = document as unknown as Record<string, unknown>;
	const surface = doc["modelContext"] as { getTools?: unknown } | undefined;
	if (
		typeof surface !== "object" ||
		surface === null ||
		typeof surface.getTools !== "function"
	) {
		// A page with no tools is a quiet no-op, not an error.
		return { tools: [] };
	}
	const listed: unknown = await (
		surface.getTools as () => Promise<unknown>
	).call(surface);
	if (!Array.isArray(listed)) {
		return { tools: [] };
	}
	const tools: Record<string, unknown>[] = [];
	for (const entry of listed) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const annotations = record["annotations"] as
			| Record<string, unknown>
			| undefined;
		const origin =
			typeof record["origin"] === "string" ? (record["origin"] as string) : "";
		const frameOrigin = String(location.origin);
		const schema = record["inputSchema"];
		const schemaJson =
			typeof schema === "object" && schema !== null
				? JSON.stringify(schema)
				: "{}";
		// The keys the page says it accepts. Inlined rather than shared with the
		// single-tool projection because this function is serialized alone: a
		// call to a module-level helper would not survive the hop. A schema that
		// is not a plain object of properties declares nothing, which fails
		// closed rather than admitting keys.
		const props =
			typeof schema === "object" && schema !== null && !Array.isArray(schema)
				? (schema as Record<string, unknown>)["properties"]
				: undefined;
		const declaredKeys =
			typeof props === "object" && props !== null && !Array.isArray(props)
				? Object.keys(props as Record<string, unknown>)
				: [];
		tools.push({
			name: record["name"],
			description: record["description"],
			origin,
			frameOrigin,
			consequentialHint: annotations?.["consequentialHint"] === true,
			readOnlyHint: annotations?.["readOnlyHint"] === true,
			// Ours: the page does not report a definition version, so the worker
			// derives one from the definition it just read. It changes when the
			// definition changes, which is what the approval binding must catch.
			definitionVersion: schemaJson,
			// The keys the page says it accepts. The worker minimises arguments
			// against these rather than against whatever the caller sent.
			declaredKeys: declaredKeys,
		});
	}
	return { tools };
}

/**
 * Fetch one tool's definition by name. Self-contained.
 *
 * Returns the same projection `listToolsInPage` builds, not the raw entry: a
 * registered tool carries a live `window` reference, which cannot cross back
 * through injection and would leave the worker holding something it cannot
 * validate.
 */
async function getToolInPage(arg: unknown): Promise<unknown> {
	const wanted = (arg as { name?: unknown } | null)?.name;
	const doc = document as unknown as Record<string, unknown>;
	const surface = doc["modelContext"] as { getTools?: unknown } | undefined;
	if (
		typeof surface !== "object" ||
		surface === null ||
		typeof surface.getTools !== "function"
	) {
		return null;
	}
	const listed: unknown = await (
		surface.getTools as () => Promise<unknown>
	).call(surface);
	if (!Array.isArray(listed)) {
		return null;
	}
	for (const entry of listed) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		if (record["name"] !== wanted) {
			continue;
		}
		const annotations = record["annotations"] as
			| Record<string, unknown>
			| undefined;
		const origin =
			typeof record["origin"] === "string" ? (record["origin"] as string) : "";
		const schema = record["inputSchema"];
		const schemaJson =
			typeof schema === "object" && schema !== null
				? JSON.stringify(schema)
				: "{}";
		// Inlined for the same reason as in the listing projection: this function
		// is serialized alone and cannot reach a module-level helper.
		const props =
			typeof schema === "object" && schema !== null && !Array.isArray(schema)
				? (schema as Record<string, unknown>)["properties"]
				: undefined;
		const declaredKeys =
			typeof props === "object" && props !== null && !Array.isArray(props)
				? Object.keys(props as Record<string, unknown>)
				: [];
		return {
			name: record["name"],
			description: record["description"],
			origin,
			frameOrigin: String(location.origin),
			consequentialHint: annotations?.["consequentialHint"] === true,
			readOnlyHint: annotations?.["readOnlyHint"] === true,
			definitionVersion: schemaJson,
			declaredKeys,
		};
	}
	return null;
}

/** Invoke one tool in the page. Self-contained. */
async function executeToolInPage(arg: unknown): Promise<unknown> {
	const request = arg as { name?: unknown; args?: unknown } | null;
	const doc = document as unknown as Record<string, unknown>;
	const surface = doc["modelContext"] as
		| { getTools?: unknown; executeTool?: unknown }
		| undefined;
	if (
		typeof surface !== "object" ||
		surface === null ||
		typeof surface.getTools !== "function" ||
		typeof surface.executeTool !== "function"
	) {
		throw new Error("no tools context");
	}
	const listed: unknown = await (
		surface.getTools as () => Promise<unknown>
	).call(surface);
	if (!Array.isArray(listed)) {
		throw new Error("tool not found");
	}
	const wanted = request?.name;
	const tool = listed.find(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			(entry as Record<string, unknown>)["name"] === wanted,
	);
	if (tool === undefined) {
		// Absent at the moment of the request is a typed error, not a retry loop.
		throw new Error(`tool not found: ${String(wanted)}`);
	}
	const result: unknown = await (
		surface.executeTool as (t: unknown, a: unknown) => Promise<unknown>
	).call(surface, tool, request?.args ?? {});
	return result;
}

/**
 * Injected functions, keyed by the same enumerated names the library uses. The
 * map is closed over constants only; it cannot be extended from page-supplied
 * data, and an unknown name never reaches a function.
 */
const INJECTORS = {
	listTools: listToolsInPage,
	getTool: getToolInPage,
	executeTool: executeToolInPage,
} as const;

/** Inject one handler into a tab's Main world and return its result. */
async function inject(
	tabId: number,
	frameId: number,
	handler: keyof typeof INJECTORS,
	args: unknown,
): Promise<unknown> {
	const results = await chrome.scripting.executeScript({
		target: { tabId, frameIds: [frameId] },
		world: "MAIN",
		func: INJECTORS[handler],
		args: [args],
	});
	const first = results[0];
	if (first === undefined) {
		throw new Error("no injection result");
	}
	return first.result;
}

const approvals = new ApprovalStore();

/**
 * The local audit trail. Held outside any page lifetime and labelled as such:
 * page-unreachable is not tamper-proof, and `AUDIT_TRAIL_DISCLAIMER` says so
 * wherever it is presented.
 */
const trail = new WorkerAuditTrail();

/** Validate a Main-world listing into the worker's own view. */
function readToolViews(payload: unknown): Array<Record<string, unknown>> {
	if (typeof payload !== "object" || payload === null) {
		return [];
	}
	const tools = (payload as Record<string, unknown>)["tools"];
	if (!Array.isArray(tools)) {
		return [];
	}
	const views: Array<Record<string, unknown>> = [];
	for (const entry of tools) {
		// A lookup that found nothing is absence, not a malformed tool. Reading
		// it as malformed would turn "this page has no such tool" into a
		// boundary-validation failure and hide which one actually happened.
		if (entry === null || entry === undefined) {
			continue;
		}
		// Hostile even though our own injected code produced it: the page realm
		// can subvert anything the function touches.
		const view = validateFrameTool(entry);
		views.push({ ...view });
	}
	return views;
}

async function handle(request: InjectionRequest): Promise<unknown> {
	const handler = assertHandlerName(request.handler);
	const args = (request.args ?? {}) as Record<string, unknown>;
	const tabId = args["tabId"];
	const frameId = args["frameId"] ?? 0;
	if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) {
		throw new TypeError("bad tabId");
	}
	if (
		typeof frameId !== "number" ||
		!Number.isInteger(frameId) ||
		frameId < 0
	) {
		throw new TypeError("bad frameId");
	}
	if (handler === "listTools") {
		const views = readToolViews(await inject(tabId, frameId, "listTools", {}));
		return { tools: views };
	}
	if (handler === "getTool") {
		const name = args["name"];
		if (typeof name !== "string") {
			throw new TypeError("bad tool name");
		}
		return readToolViews({
			tools: [await inject(tabId, frameId, "getTool", { name })],
		}).filter((view) => view["name"] === name);
	}
	const name = args["name"];
	if (typeof name !== "string") {
		throw new TypeError("bad tool name");
	}
	const callArgs = args["args"] ?? {};
	const views = readToolViews({
		tools: [await inject(tabId, frameId, "getTool", { name })],
	});
	const view = views[0];
	if (view === undefined) {
		throw new TypeError("tool not found");
	}
	const ownerOrigin = String(view["origin"]);
	const callerOrigin = args["callerOrigin"];
	if (typeof callerOrigin !== "string") {
		throw new TypeError("bad caller origin");
	}
	// Exposure is re-checked here against validated values, never against what
	// the page asserted about itself.
	const allowed = Array.isArray(args["allowedOrigins"])
		? (args["allowedOrigins"] as string[])
		: [];
	if (!isExposedToCaller(ownerOrigin, allowed, callerOrigin)) {
		throw new TypeError("tool not exposed");
	}
	const definitionVersion = String(view["definitionVersion"]);
	// Only keys this worker permits cross into the page. Anything the caller
	// sent that was not asked for is dropped rather than forwarded.
	const minimised = applyArgAllowList(callArgs, allowedArgKeys(args, view));
	// Built through the validating constructor rather than by literal, so a
	// malformed part rejects here instead of reaching the store.
	const key = createHitlKey({
		tabId,
		documentId: String(args["documentId"] ?? ""),
		frameId,
		toolName: name,
		argsHash: hashArgs(canonicalizeArgs(minimised)),
	});
	if (view["consequentialHint"] === true) {
		// A Consequential tool never runs on the strength of the caller's claim.
		const binding = hitlKeyToString(key);
		const pending = approvals.pendingKeys();

		// A person was asked about *this tool on this tab*, and the invocation
		// now in hand is not the one they saw. That is a moved binding, and the
		// answer is refusal. Falling through to ask again would train a person to
		// click through, which defeats the control entirely — so it throws
		// rather than re-prompting.
		const moved = pending.find(
			(candidate) => candidate !== binding && sameTarget(candidate, key),
		);
		if (moved !== undefined) {
			approvals.rejectApproval(moved);
			filed.delete(moved);
			throw new TypeError("approval target changed");
		}

		const alreadyApproved = pending.includes(binding);
		if (alreadyApproved) {
			// The person has already been asked about this exact invocation. The
			// binding is re-verified against live values here, not at the moment
			// of the click, because the page has had time to move underneath it.
			approvals.verifyAndConsume(binding, key, definitionVersion);
			trail.append({
				key: binding,
				toolName: name,
				origin: ownerOrigin,
				decision: "executed",
			});
			return inject(tabId, frameId, "executeTool", { name, args: minimised });
		}
		// Not yet approved: return what a person needs in order to decide, and
		// do not execute. The caller is expected to come back after approval.
		return {
			pendingApproval: binding,
			requiresConfirmation: true,
			toolName: name,
			description: String(view["description"]),
			argsJson: canonicalizeArgs(minimised),
			definitionVersion,
			origin: ownerOrigin,
			callerOrigin,
			allowedOrigins: allowed,
			consequentialHint: true,
			readOnlyHint: view["readOnlyHint"] === true,
		};
	}
	// Non-consequential: the handler and the context are checked against
	// validated values. Exposure was already decided above, before the two paths
	// diverged, so it is not re-decided here. The approval store is
	// deliberately not consulted — there is nothing to approve.
	assertHandlerName(handler);
	assertLiveContext(true);
	return inject(tabId, frameId, "executeTool", { name, args: minimised });
}

/** What the panel shows, and what a person's click decides on. */
export interface PanelApproval {
	readonly key: string;
	readonly toolName: string;
	readonly description: string;
	readonly argsJson: string;
	readonly origin: string;
}

/**
 * What each pending approval was filed for.
 *
 * Held here rather than read back out of the store: the panel must render the
 * exact text the person approved, and a hash is not renderable. The binding is
 * still the store's; this is only the display copy.
 */
const filed = new Map<string, PanelApproval>();

/**
 * Tell an open panel the pending set changed.
 *
 * The panel has no subscription of its own worth trusting, so it re-reads the
 * worker rather than trusting a pushed payload. The notification carries no
 * approval data at all — it is a hint to look again.
 */
function announceChange(): void {
	void chrome.runtime.sendMessage({ handler: "pendingChanged" }).catch(() => {
		// No panel is open. That is the common case, not a failure.
	});
}

/**
 * File a pending approval on a person's gesture.
 *
 * Gesture-initiated by construction: the store itself rejects a non-gesture
 * request, so a daemon cannot manufacture an approval by asking twice.
 */
function requestApproval(details: unknown, gesture: unknown): PanelApproval {
	const record = details as Record<string, unknown>;
	const binding = approvals.requestApproval(details, gesture);
	const entry: PanelApproval = {
		key: binding,
		toolName: String(record["toolName"]),
		description: String(record["description"]),
		argsJson: String(record["argsJson"]),
		origin: String(record["origin"]),
	};
	filed.set(binding, entry);
	trail.append({
		key: binding,
		toolName: entry.toolName,
		origin: entry.origin,
		decision: "requested",
	});
	announceChange();
	return entry;
}

/** Approve a filed approval. A person's click, never the daemon's word. */
function approveApproval(key: unknown): void {
	approvals.approveApproval(key);
	const entry = filed.get(String(key));
	if (entry !== undefined) {
		trail.append({
			key: entry.key,
			toolName: entry.toolName,
			origin: entry.origin,
			decision: "approved",
		});
	}
	announceChange();
}

/** Reject a filed approval. */
function rejectApproval(key: unknown): void {
	const entry = filed.get(String(key));
	approvals.rejectApproval(key);
	filed.delete(String(key));
	if (entry !== undefined) {
		trail.append({
			key: entry.key,
			toolName: entry.toolName,
			origin: entry.origin,
			decision: "rejected",
		});
	}
	announceChange();
}

/** Pending approvals, for the panel to render. */
function pendingApprovals(): PanelApproval[] {
	return approvals
		.pendingKeys()
		.map((key) => filed.get(key))
		.filter((entry): entry is PanelApproval => entry !== undefined);
}

/**
 * The keys the caller is asking to cross into the page.
 *
 * An explicit list is honoured as given. Absent one, the keys are derived from
 * the tool's own declared input schema and intersected with what the caller
 * actually sent, so the page receives a shape this worker chose: a caller
 * cannot introduce a key the page never declared for itself.
 *
 * Deriving from the caller's own keys instead would forward whatever the caller
 * sent, which makes this function a no-op and lets an agent smuggle arbitrary
 * arguments into a tool that never asked to receive them.
 */
function declaredArgKeys(view: Record<string, unknown>): string[] {
	const declared = view["declaredKeys"];
	if (!Array.isArray(declared)) {
		return [];
	}
	return declared.filter((key): key is string => typeof key === "string");
}

function allowedArgKeys(
	args: Record<string, unknown>,
	view: Record<string, unknown>,
): string[] {
	const declared = args["allowedKeys"];
	const callArgs = args["args"];
	if (typeof callArgs !== "object" || callArgs === null) {
		return [];
	}
	if (declared !== undefined) {
		if (!Array.isArray(declared)) {
			throw new TypeError("bad allow-list");
		}
		return declared.filter((key): key is string => typeof key === "string");
	}
	const permitted = new Set(declaredArgKeys(view));
	return Object.keys(callArgs as Record<string, unknown>).filter((key) =>
		permitted.has(key),
	);
}

/**
 * True when two bindings name the same target — tab, document, frame, and
 * tool — and differ only in what is being asked for.
 *
 * The binding's string form is a five-element JSON array, so the identity is
 * the first three elements plus the tool name at the fourth.
 */
function sameTarget(binding: string, key: HitlKey): boolean {
	try {
		const parts: unknown = JSON.parse(binding);
		if (!Array.isArray(parts) || parts.length !== 5) {
			return false;
		}
		return (
			parts[0] === key.tabId &&
			parts[1] === key.documentId &&
			parts[2] === key.frameId &&
			parts[3] === key.toolName
		);
	} catch {
		return false;
	}
}

/**
 * The confirmation surface, as the panel drives it.
 *
 * Four enumerated operations, no dispatch. `request` requires a gesture and the
 * store enforces it, so the daemon cannot reach any of this by asking.
 */
export const PANEL_OPERATIONS = [
	"request",
	"approve",
	"reject",
	"list",
] as const;

export type PanelOperation = (typeof PANEL_OPERATIONS)[number];

/** Run one panel operation. Arguments are validated before use. */
function panel(op: unknown, args: unknown): unknown {
	if (typeof op !== "string") {
		throw new TypeError("bad panel operation");
	}
	if (!PANEL_OPERATIONS.includes(op as PanelOperation)) {
		throw new TypeError("unknown panel operation");
	}
	const record =
		typeof args === "object" && args !== null
			? (args as Record<string, unknown>)
			: {};
	if (op === "request") {
		return requestApproval(record["approval"], record["gesture"]);
	}
	if (op === "list") {
		return { pending: pendingApprovals(), disclaimer: AUDIT_TRAIL_DISCLAIMER };
	}
	if (op === "approve") {
		approveApproval(record["key"]);
		return { ok: true };
	}
	rejectApproval(record["key"]);
	return { ok: true };
}

/**
 * A pending confirmation does not survive navigation.
 *
 * An approval is bound to the document the person was shown. When the tab
 * navigates that document is gone, so a confirmation left standing would
 * authorise an invocation against whatever loaded next — the one case where
 * the binding could outlive its own subject.
 *
 * `chrome.tabs.onUpdated` reporting `status: "loading"` is the browser's own
 * signal and needs no permission beyond the host access already requested.
 * The store is keyed on the reported tab rather than on a document identifier
 * the caller supplied, so what gets discarded is decided from something the
 * browser said rather than something the caller asked.
 */
chrome.tabs.onUpdated.addListener(
	(tabId: number, changeInfo: { status?: unknown }): void => {
		if (changeInfo.status !== "loading") {
			return;
		}
		approvals.invalidateTab(tabId);
		void chrome.runtime.sendMessage({ handler: "pendingChanged" }).catch(() => {
			// No panel listening. The invalidation above already happened.
		});
	},
);

chrome.runtime.onMessage.addListener(
	(
		message: unknown,
		_sender: unknown,
		sendResponse: (value: unknown) => void,
	) => {
		const record = (message ?? {}) as Record<string, unknown>;
		// The panel's operations are a separate, closed set. They are not
		// reachable by naming an injection handler, and an injection handler is
		// not reachable by naming a panel operation.
		const panelOp = record["panel"];
		if (typeof panelOp === "string") {
			try {
				sendResponse({ ok: true, result: panel(panelOp, record["args"]) });
			} catch (error: unknown) {
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "panel failed",
				});
			}
			return false;
		}
		let request: InjectionRequest;
		try {
			request = createInjectionRequest(record["handler"], record["args"]);
		} catch (error: unknown) {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : "bad request",
			});
			return false;
		}
		handle(request).then(
			(result: unknown) => sendResponse({ ok: true, result }),
			(error: unknown) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "request failed",
				}),
		);
		// Keep the message channel open for the async reply.
		return true;
	},
);

// Exposed for the extension's own pages and for tests driving the worker
// directly. Not reachable from the page: the worker's global is not a page
// global, and the manifest denies external connections.
Object.assign(globalThis as unknown as Record<string, unknown>, {
	__axHandle: handle,
	__axApprovals: approvals,
	__axPanel: panel,
	__axTrail: trail,
	// The canonicaliser and hasher, so a caller filing an approval derives the
	// same binding the worker will check rather than reimplementing the rule.
	__axHash: (text: string) =>
		hashArgs(canonicalizeArgs(JSON.parse(text) as unknown)),
});
