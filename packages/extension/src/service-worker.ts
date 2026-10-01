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
import {
	ApprovalStore,
	canonicalizeArgs,
	createHitlKey,
	hashArgs,
	hitlKeyToString,
} from "./hitl.js";
import {
	applyArgAllowList,
	isExposedToCaller,
	validateFrameTool,
} from "./trusted-tier.js";
import { assertLiveContext } from "./manifest.js";

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
		const schemaJson =
			typeof record["inputSchema"] === "object" &&
			record["inputSchema"] !== null
				? JSON.stringify(record["inputSchema"])
				: "{}";
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
		const schemaJson =
			typeof record["inputSchema"] === "object" && record["inputSchema"] !== null
				? JSON.stringify(record["inputSchema"])
				: "{}";
		return {
			name: record["name"],
			description: record["description"],
			origin,
			frameOrigin: String(location.origin),
			consequentialHint: annotations?.["consequentialHint"] === true,
			readOnlyHint: annotations?.["readOnlyHint"] === true,
			definitionVersion: schemaJson,
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
	const argsJson = canonicalizeArgs(callArgs);
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
	// Only allow-listed keys cross into the page. Anything the caller sent that
	// was not asked for is dropped rather than forwarded.
	const minimised = applyArgAllowList(callArgs, allowedArgKeys(args));
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
		// It returns the pending binding and waits for a person.
		return {
			pendingApproval: hitlKeyToString(key),
			requiresConfirmation: true,
			toolName: name,
			description: String(view["description"]),
			argsJson: canonicalizeArgs(minimised),
			definitionVersion,
			origin: ownerOrigin,
		};
	}
	// Non-consequential: the handler, the context, and the exposure gate are
	// checked against validated values. The approval store is deliberately not
	// consulted — there is nothing to approve.
	assertHandlerName(handler);
	assertLiveContext(true);
	if (!isExposedToCaller(ownerOrigin, allowed, callerOrigin)) {
		throw new TypeError("tool not exposed");
	}
	return inject(tabId, frameId, "executeTool", { name, args: minimised });
}

/**
 * The keys the caller is asking to cross into the page.
 *
 * Absent a list, the caller's own keys are taken as the request — but they are
 * still filtered through the allow-list, so the shape the page receives is
 * always one the worker chose.
 */
function allowedArgKeys(args: Record<string, unknown>): string[] {
	const declared = args["allowedKeys"];
	if (Array.isArray(declared)) {
		return declared.filter((key): key is string => typeof key === "string");
	}
	const callArgs = args["args"];
	if (typeof callArgs !== "object" || callArgs === null) {
		return [];
	}
	return Object.keys(callArgs as Record<string, unknown>);
}

chrome.runtime.onMessage.addListener(
	(
		message: unknown,
		_sender: unknown,
		sendResponse: (value: unknown) => void,
	) => {
		let request: InjectionRequest;
		try {
			const record = (message ?? {}) as Record<string, unknown>;
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
});
