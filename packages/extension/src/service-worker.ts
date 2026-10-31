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
import type { ApprovalDetails } from "./hitl.js";
import {
	ApprovalStore,
	canonicalizeArgs,
	createHitlKey,
	hashArgs,
	hitlKeyToString,
} from "./hitl.js";
import { startRelay } from "./relay-host.js";
import type { FrameToolView } from "./trusted-tier.js";
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
	const surface = doc.modelContext as { getTools?: unknown } | undefined;
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
		const annotations = record.annotations as
			| Record<string, unknown>
			| undefined;
		const origin =
			typeof record.origin === "string" ? (record.origin as string) : "";
		const frameOrigin = String(location.origin);
		const schema = record.inputSchema;
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
				? (schema as Record<string, unknown>).properties
				: undefined;
		const declaredKeys =
			typeof props === "object" && props !== null && !Array.isArray(props)
				? Object.keys(props as Record<string, unknown>)
				: [];
		// Ours: the page does not report a definition version, so the worker
		// derives one from the definition it just read. It covers every field a
		// person is shown when they approve: a version built from the schema
		// alone would let a page change what it says the tool does, or what
		// consequence it carries, and keep the approval given to the old words.
		const definitionVersion = JSON.stringify([
			record.name,
			record.description,
			annotations?.consequentialHint === true,
			annotations?.readOnlyHint === true,
			schemaJson,
		]);
		tools.push({
			name: record.name,
			description: record.description,
			origin,
			frameOrigin,
			consequentialHint: annotations?.consequentialHint === true,
			readOnlyHint: annotations?.readOnlyHint === true,
			definitionVersion,
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
	const surface = doc.modelContext as { getTools?: unknown } | undefined;
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
		if (record.name !== wanted) {
			continue;
		}
		const annotations = record.annotations as
			| Record<string, unknown>
			| undefined;
		const origin =
			typeof record.origin === "string" ? (record.origin as string) : "";
		const schema = record.inputSchema;
		const schemaJson =
			typeof schema === "object" && schema !== null
				? JSON.stringify(schema)
				: "{}";
		// Inlined for the same reason as in the listing projection: this function
		// is serialized alone and cannot reach a module-level helper.
		const props =
			typeof schema === "object" && schema !== null && !Array.isArray(schema)
				? (schema as Record<string, unknown>).properties
				: undefined;
		const declaredKeys =
			typeof props === "object" && props !== null && !Array.isArray(props)
				? Object.keys(props as Record<string, unknown>)
				: [];
		return {
			name: record.name,
			description: record.description,
			origin,
			frameOrigin: String(location.origin),
			consequentialHint: annotations?.consequentialHint === true,
			readOnlyHint: annotations?.readOnlyHint === true,
			// The same value the listing projection builds, from the same fields.
			// Two projections of one tool that disagreed here would let an approval
			// be checked against a version the person was never shown.
			definitionVersion: JSON.stringify([
				record.name,
				record.description,
				annotations?.consequentialHint === true,
				annotations?.readOnlyHint === true,
				schemaJson,
			]),
			declaredKeys,
		};
	}
	return null;
}

/**
 * Invoke one tool in the page. Self-contained.
 *
 * The definition version is re-derived here, from the entry this call is about
 * to execute, and compared with the one the worker approved. Checking it in the
 * worker's earlier `getTool` injection would be checking a different read: the
 * page chooses what each of its two listings says, and between them there is an
 * `await` boundary and the page controls the timing. Only the entry used to
 * execute is the entry that matters, so that is the entry checked.
 *
 * Untested against a real browser. The check is present in the emitted worker
 * and is exercised by the definition-drift cases in the authorization suite, but
 * a test that isolated *this* read from the worker's own proved order-dependent:
 * it passed only because earlier cases had already advanced the page's read
 * counter. The check is kept because it closes the window the comment describes
 * and costs nothing, not because a green test stands behind it.
 */
async function executeToolInPage(arg: unknown): Promise<unknown> {
	const request = arg as {
		name?: unknown;
		args?: unknown;
		definitionVersion?: unknown;
	} | null;
	const doc = document as unknown as Record<string, unknown>;
	const surface = doc.modelContext as
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
			(entry as Record<string, unknown>).name === wanted,
	);
	if (tool === undefined) {
		// Absent at the moment of the request is a typed error, not a retry loop.
		throw new Error(`tool not found: ${String(wanted)}`);
	}
	if (typeof request?.definitionVersion === "string") {
		// Inlined for the same reason as the two projections above: this function
		// is serialized alone and cannot reach a module-level helper.
		const record = tool as Record<string, unknown>;
		const annotations = record.annotations as
			| Record<string, unknown>
			| undefined;
		const schema = record.inputSchema;
		const live = JSON.stringify([
			record.name,
			record.description,
			annotations?.consequentialHint === true,
			annotations?.readOnlyHint === true,
			typeof schema === "object" && schema !== null
				? JSON.stringify(schema)
				: "{}",
		]);
		if (live !== request.definitionVersion) {
			throw new Error("tool definition changed");
		}
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

/**
 * The tab the person is looking at, read from the browser.
 *
 * A client on the other side of a socket has no concept of a tab, so "which
 * one" has to be answered by asking rather than guessing. Guessing would pick
 * whichever tab was created first, which for a tool that spends money is the
 * worst available answer.
 *
 * The origin travels with it because the caller needs one and cannot honestly
 * invent one: this worker has no origin of its own, and the page is exposed to
 * itself. It is read from the tab's own URL rather than composed.
 */
async function readActiveTab(): Promise<{ tabId: number; origin: string }> {
	const tabs = await chrome.tabs.query({
		active: true,
		lastFocusedWindow: true,
	});
	const tab = tabs[0];
	if (tab === undefined || typeof tab.id !== "number") {
		throw new TypeError("no active tab");
	}
	const url = typeof tab.url === "string" ? tab.url : tab.pendingUrl;
	if (typeof url !== "string" || url.length === 0) {
		throw new TypeError("no tab origin");
	}
	const origin = new URL(url).origin;
	if (origin === "null") {
		throw new TypeError("opaque tab origin");
	}
	return { tabId: tab.id, origin };
}

/**
 * The document identities this worker has seen, keyed by tab and frame.
 *
 * `chrome.tabs.Tab` has no `documentId` — checked against the API reference
 * rather than assumed — so the only browser-asserted identities available are
 * the ones `webNavigation` reports at commit time. That is exactly what an
 * approval needs to be bound to: a value the browser asserts, which a page
 * cannot forge and a caller cannot compose.
 *
 * The previous code passed `tab-${tabId}` and called it a placeholder. A string
 * that survives every navigation in a tab is not a weaker document identity, it
 * is no document identity at all, and it outlives the thing it was standing in
 * for.
 */
const documents = new Map<string, { documentId: string; lifecycle: string }>();

function frameKey(tabId: number, frameId: number): string {
	return `${String(tabId)}:${String(frameId)}`;
}

chrome.webNavigation.onCommitted.addListener((details) => {
	const { tabId, frameId, documentId, documentLifecycle } = details;
	if (
		typeof tabId !== "number" ||
		typeof frameId !== "number" ||
		typeof documentId !== "string" ||
		documentId.length === 0
	) {
		return;
	}
	const key = frameKey(tabId, frameId);
	documents.set(key, {
		documentId,
		lifecycle:
			typeof documentLifecycle === "string" ? documentLifecycle : "active",
	});
	// A commit is the browser saying the document an approval was bound to is
	// gone. This is the earliest and most reliable point at which that is true:
	// `onBeforeNavigate` fires before a document id exists to bind to.
	invalidateApprovalsFor(tabId, "the tab navigated");
});

/**
 * The live document identity for a frame, or null when this worker has not
 * seen one.
 *
 * Absent means the worker cannot bind an approval, and refusing is the right
 * answer rather than falling back to something weaker: an unbound approval is
 * exactly the thing a replayed call is trying to obtain.
 */
function liveDocument(
	tabId: number,
	frameId: number,
): { documentId: string; lifecycle: string } | null {
	return documents.get(frameKey(tabId, frameId)) ?? null;
}

/**
 * Re-learn the browser's document identity for a frame when the commit
 * record has nothing for it.
 *
 * The record is in-memory, so a worker that started after the commit has
 * nothing in it: a slow start under load, or a revival after an idle stop
 * with no navigation since to re-fire `onCommitted`. The browser still
 * knows, so ask it for the frame rather than refusing a call a person could
 * approve. The answer is the browser's own record — the same source the
 * commit listener copies — never anything the caller supplied, so the
 * binding loses nothing by it. A frame the browser will not confirm returns
 * null, which fails closed at the call site exactly as a cache miss does.
 */
async function readFrameDocument(
	tabId: number,
	frameId: number,
): Promise<{ documentId: string; lifecycle: string } | null> {
	let frame: unknown;
	try {
		frame = await chrome.webNavigation.getFrame({ tabId, frameId });
	} catch {
		return null;
	}
	if (typeof frame !== "object" || frame === null) {
		return null;
	}
	const record = frame as Record<string, unknown>;
	const { documentId, documentLifecycle } = record;
	if (typeof documentId !== "string" || documentId.length === 0) {
		return null;
	}
	const seen = {
		documentId,
		lifecycle:
			typeof documentLifecycle === "string" ? documentLifecycle : "active",
	};
	// The lookup above awaited, so a commit may have stored a newer record
	// while it was in flight. Chrome orders navigation events, not this
	// lookup against them, so a late answer must not overwrite what arrived
	// after it was asked for.
	const current = liveDocument(tabId, frameId);
	if (current !== null) {
		return current;
	}
	documents.set(frameKey(tabId, frameId), seen);
	return seen;
}

/**
 * Ask the browser whether these three still name one live document.
 *
 * This is the anti-replay gate, and it is the browser's answer rather than a
 * comparison of strings this package composed. A tab, a frame and a document id
 * that do not go together any more are not a document; they are three plausible
 * values from three different moments.
 */
async function documentIsLive(
	tabId: number,
	frameId: number,
	documentId: string,
): Promise<boolean> {
	try {
		const frame: unknown = await chrome.webNavigation.getFrame({
			tabId,
			frameId,
			documentId,
		});
		return frame !== null && frame !== undefined;
	} catch {
		// A lookup that throws is the browser declining to confirm it. Failing
		// closed here is the point: the alternative is treating an unconfirmable
		// identity as confirmed.
		return false;
	}
}

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
 * The local audit trail. Held in the worker's own memory, outside any page
 * lifetime, and labelled as such: page-unreachable is not tamper-proof, and
 * `AUDIT_TRAIL_DISCLAIMER` says so wherever it is presented. It does not
 * survive the browser stopping an idle worker, so it is a record of this
 * session rather than a ledger.
 */
const trail = new WorkerAuditTrail();

/** Validate a Main-world listing into the worker's own view. */
function readToolViews(payload: unknown): FrameToolView[] {
	if (typeof payload !== "object" || payload === null) {
		return [];
	}
	const tools = (payload as Record<string, unknown>).tools;
	if (!Array.isArray(tools)) {
		return [];
	}
	const views: FrameToolView[] = [];
	for (const entry of tools) {
		// A lookup that found nothing is absence, not a malformed tool. Reading
		// it as malformed would turn "this page has no such tool" into a
		// boundary-validation failure and hide which one actually happened.
		if (entry === null || entry === undefined) {
			continue;
		}
		// Hostile even though our own injected code produced it: the page realm
		// can subvert anything the function touches. `validateFrameTool` builds a
		// fresh literal, so what it returns is already this worker's own copy.
		views.push(validateFrameTool(entry));
	}
	return views;
}

async function handle(request: InjectionRequest): Promise<unknown> {
	const handler = assertHandlerName(request.handler);
	const args = (request.args ?? {}) as Record<string, unknown>;
	const tabId = args.tabId;
	const frameId = args.frameId ?? 0;
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
		const name = args.name;
		if (typeof name !== "string") {
			throw new TypeError("bad tool name");
		}
		return readToolViews({
			tools: [await inject(tabId, frameId, "getTool", { name })],
		}).filter((view) => view.name === name);
	}
	const name = args.name;
	if (typeof name !== "string") {
		throw new TypeError("bad tool name");
	}
	const callArgs = args.args ?? {};
	const views = readToolViews({
		tools: [await inject(tabId, frameId, "getTool", { name })],
	});
	const view = views[0];
	if (view === undefined) {
		throw new TypeError("tool not found");
	}
	const ownerOrigin = view.origin;
	const callerOrigin = args.callerOrigin;
	if (typeof callerOrigin !== "string") {
		throw new TypeError("bad caller origin");
	}
	// Exposure is decided here, from the page's own origin only.
	//
	// Two things this is not. It is not an authorisation boundary: `callerOrigin`
	// arrives in the request, so a caller names its own identity here exactly as
	// it used to name its own allow-list. What the removal buys is that the
	// *policy* — the set of origins admitted — is no longer something a caller
	// chooses. The manifest denies external connections, so the callers that can
	// reach this are the extension's own pages rather than the open internet.
	//
	// The draft also lets a definition widen itself with `exposedTo`. The
	// registered-tool listing does not carry the declared set, so this worker has
	// none to honour and admits the page's own origin: the draft's default.
	// Widening that needs the declared set to reach the worker, and an identity
	// the browser asserts rather than one the caller does.
	const allowed: ReadonlyArray<string> = [];
	if (!isExposedToCaller(ownerOrigin, allowed, callerOrigin)) {
		throw new TypeError("tool not exposed");
	}
	const definitionVersion = view.definitionVersion;
	// Only keys this worker permits cross into the page. Anything the caller
	// sent that was not asked for is dropped rather than forwarded.
	const minimised = applyArgAllowList(callArgs, allowedArgKeys(callArgs, view));
	if (view.consequentialHint === true) {
		// Built through the validating constructor rather than by literal, so a
		// malformed part rejects here instead of reaching the store. Only a
		// consequential call needs a document to bind an approval to: asking a
		// read-only tool for one would refuse an invocation that involves no
		// approval at all.
		//
		// The identity is read from the browser's own commit record, never from
		// the request. A caller that named its own `documentId` would be choosing
		// the target its approval applies to, which is the one thing the binding
		// exists to prevent.
		//
		// The record is only a cache: a worker that started after the commit —
		// measured on release run 38681385339, where a slow start under load
		// missed it and every consequential call threw for the rest of the
		// run — re-learns the frame from the browser rather than refusing.
		const live =
			liveDocument(tabId, frameId) ?? (await readFrameDocument(tabId, frameId));
		if (live === null) {
			throw new TypeError(
				"no document identity is known for this frame, so nothing can be approved against it",
			);
		}
		// A prerendered document is not the document the person is looking at.
		// Binding an approval to one would authorise a call against a page that
		// may never be shown.
		if (live.lifecycle === "prerender") {
			throw new TypeError(
				"that frame is prerendered, not the document in view",
			);
		}
		const { documentId } = live;
		if (!(await documentIsLive(tabId, frameId, documentId))) {
			// The recorded identity no longer names a live document, so the tab
			// moved between the commit and this call. Refuse rather than ask: the
			// person was never shown anything about this document.
			throw new TypeError("the document moved before the call arrived");
		}
		const argsJson = canonicalizeArgs(minimised);
		const key = createHitlKey({
			tabId,
			documentId,
			frameId,
			toolName: name,
			argsHash: hashArgs(argsJson),
		});
		// A Consequential tool never runs on the strength of the caller's claim.
		const binding = hitlKeyToString(key);
		const pending = approvals.pendingKeys();

		// A person was asked about *this tool on this tab*, and the invocation
		// now in hand is not the one they saw. That is a moved binding, and the
		// answer is refusal. Falling through to ask again would train a person to
		// click through, which defeats the control entirely — so it throws
		// rather than re-prompting.
		const moved = approvals
			.pendingBindingsFor(key)
			.find((candidate) => candidate !== binding);
		if (moved !== undefined) {
			approvals.rejectApproval(moved);
			filed.delete(moved);
			throw new TypeError("approval target changed");
		}

		const alreadyApproved = approvals.isApproved(binding);
		if (alreadyApproved) {
			// The person has already been asked about this exact invocation. The
			// binding is re-verified against live values here, not at the moment
			// of the click, because the page has had time to move underneath it.
			try {
				approvals.verifyAndConsume(binding, key, definitionVersion);
			} finally {
				// Spent or invalidated, the copy the panel rendered goes either
				// way. Left here it would hold a page-supplied description and
				// argument string for the life of the worker.
				filed.delete(binding);
				announceChange();
			}
			trail.append({
				key: binding,
				toolName: name,
				origin: ownerOrigin,
				decision: "executed",
			});
			return inject(tabId, frameId, "executeTool", {
				name,
				args: minimised,
				definitionVersion,
			});
		}
		// Asked and not yet answered: the person is the one who answers, so the
		// question has to be on the panel. Filing is idempotent — asking twice
		// must not raise a second card or clear an answer already given. A
		// definition change re-files so the card shows what will execute.
		if (
			!pending.includes(binding) ||
			approvals.pendingDefinitionVersion(binding) !== definitionVersion
		) {
			fileApproval({
				key,
				toolName: name,
				description: view.description,
				origin: ownerOrigin,
				frameOrigin: view.frameOrigin,
				argsJson,
				consequentialHint: true,
				readOnlyHint: view.readOnlyHint,
				definitionVersion,
			});
		}
		// Return what a person needs in order to decide, and do not execute. The
		// caller comes back once the answer is in.
		return {
			pendingApproval: binding,
			requiresConfirmation: true,
			toolName: name,
			description: view.description,
			argsJson,
			definitionVersion,
			origin: ownerOrigin,
			// The frame the tool lives in, which is not the owner origin for an
			// embedded document. `readToolOutcome` requires it and refuses to parse a
			// reply without it, so omitting it here made the daemon report a failed
			// call while this panel was standing open asking a person to approve it -
			// the outcome that teaches every client that asking is an outage.
			frameOrigin: view.frameOrigin,
			callerOrigin,
			// The admitted set is the page's own origin and nothing else, so this is
			// always empty. It is reported because a caller deciding whether to
			// retry elsewhere is better served by the policy than by guessing.
			allowedOrigins: allowed,
			consequentialHint: true,
			readOnlyHint: view.readOnlyHint,
		};
	}
	// Non-consequential: the handler name was checked against the enumerated set
	// on the way in, and the two earlier branches have returned, so what is left
	// here is `executeTool`. Exposure was decided before the paths diverged, so
	// it is not re-decided. The approval store is deliberately not consulted —
	// there is nothing to approve.
	return inject(tabId, frameId, "executeTool", {
		name,
		args: minimised,
		definitionVersion,
	});
}

/** What the panel shows, and what a person's click decides on. */
interface PanelApproval {
	readonly key: string;
	readonly definitionVersion: string;
	readonly toolName: string;
	readonly description: string;
	readonly argsJson: string;
	readonly origin: string;
	/**
	 * The origin of the frame the tool actually lives in, read from the frame
	 * itself rather than from anything the tool declared. `origin` is the page's
	 * own claim about itself; a person deciding should be shown the one value
	 * this worker observed, and a disagreement between the two is exactly what
	 * they need to see.
	 */
	readonly frameOrigin: string;
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
function announceChange(reason?: string): void {
	void chrome.runtime
		.sendMessage({ handler: "pendingChanged", reason: reason ?? "" })
		.catch(() => {
			// No panel is open. That is the common case, not a failure.
		});
}

/**
 * Say on the toolbar icon that something is waiting.
 *
 * The panel cannot simply be opened for a person. `chrome.sidePanel.open()`
 * refuses to run outside a user gesture — verified against the Chromium
 * implementation, not just the docs — and a tool call is not a gesture. So the
 * icon carries the count and the tooltip carries the reason, and the person
 * clicks. An approval they have to go and find is still an approval; an approval
 * panel that silently failed to open is not.
 */
function refreshBadge(): void {
	const pending = approvals.pendingKeys().length;
	const badge = pending > 0 ? String(Math.min(pending, 99)) : "";
	void chrome.action
		.setBadgeBackgroundColor({ color: "#1f6feb" })
		.then(() => chrome.action.setBadgeText({ text: badge }))
		.then(() =>
			chrome.action.setTitle({
				title:
					pending > 0
						? `ax-kit — ${String(pending)} confirmation${pending === 1 ? "" : "s"} waiting`
						: "ax-kit",
			}),
		)
		.catch(() => {
			// A worker that is shutting down may not get to paint the badge. The
			// panel is still the real surface; this is only a pointer to it.
		});
}

/**
 * Make the confirmation surface reachable.
 *
 * `openPanelOnActionClick` defaults to false, so without this the panel exists
 * and can never be opened by the person who needs it. The call is refused on a
 * browser that does not support it, which is not a failure worth propagating:
 * the panel can still be opened from the extensions menu.
 */
void chrome.sidePanel
	.setPanelBehavior({ openPanelOnActionClick: true })
	.catch(() => {
		// Older browser, or a context where the call is not permitted.
	});

/**
 * File a pending approval from the worker's own validated view.
 *
 * Every field is read from a tool view this worker validated, so what a person
 * is shown is what will execute — there is no path by which a caller supplies
 * the text a person approves. Filing raises a confirmation and grants nothing;
 * the answer is `approveApproval`, which only the panel's own click reaches.
 */
function fileApproval(details: ApprovalDetails): PanelApproval {
	const binding = approvals.requestApproval(details);
	const entry: PanelApproval = {
		key: binding,
		definitionVersion: details.definitionVersion,
		toolName: details.toolName,
		description: details.description,
		argsJson: details.argsJson,
		origin: details.origin,
		frameOrigin: details.frameOrigin,
	};
	filed.set(binding, entry);
	trail.append({
		key: binding,
		toolName: entry.toolName,
		origin: entry.origin,
		decision: "requested",
	});
	refreshBadge();
	announceChange(`"${entry.toolName}" is waiting for your confirmation`);
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
 * The keys that may cross into the page: what the tool declared, and no more.
 *
 * There is deliberately no branch that widens this from the request. A caller
 * that could name the permitted keys would be choosing the shape the page
 * receives, which is the one thing data minimisation exists to prevent — the
 * boundary would be exactly as strong as the least careful caller.
 *
 * `view.declaredKeys` is already the boundary's own output: validated as an
 * array of non-empty strings when the tool view was built, and typed as such.
 * Re-checking it here would be a guard nothing could make fail.
 */
function allowedArgKeys(callArgs: unknown, view: FrameToolView): string[] {
	if (typeof callArgs !== "object" || callArgs === null) {
		return [];
	}
	const permitted = new Set(view.declaredKeys);
	return Object.keys(callArgs as Record<string, unknown>).filter((key) =>
		permitted.has(key),
	);
}

/**
 * The confirmation surface, as the panel drives it.
 *
 * Three enumerated operations, no dispatch. There is no way to file an approval
 * from here: the worker files it from its own validated tool view when a
 * consequential tool is invoked, so a caller cannot put text of its own
 * choosing in front of a person as though the page had written it. Filing
 * raises the question; only `approve` answers it.
 */
const PANEL_OPERATIONS = ["approve", "reject", "list"] as const;

type PanelOperation = (typeof PANEL_OPERATIONS)[number];

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
	if (op === "list") {
		return { pending: pendingApprovals(), disclaimer: AUDIT_TRAIL_DISCLAIMER };
	}
	// A click decides on what it displayed. Re-filing replaces the pending
	// entry under the same key when the definition changes, so the version on
	// the card must match the pending version or the decision is stale: the
	// person saw old words and must see the new ones before answering. A
	// missing entry falls through so an unknown approval keeps its own error.
	const shownVersion = record.definitionVersion;
	if (typeof shownVersion !== "string") {
		throw new TypeError("approval changed");
	}
	const liveVersion = approvals.pendingDefinitionVersion(record.key);
	if (liveVersion !== undefined && liveVersion !== shownVersion) {
		throw new TypeError("approval changed");
	}
	if (op === "approve") {
		approveApproval(record.key);
		return { ok: true };
	}
	rejectApproval(record.key);
	return { ok: true };
}

/**
 * Drop every approval bound to a tab, and tell the panel.
 *
 * Called from the browser's own signals rather than from anything a caller
 * reports: a navigation, and a switch to a different tab. An approval is bound
 * to the document a person was shown, and switching tabs *hides* the side panel
 * rather than destroying it — so a card left standing is a card for a page
 * nobody is looking at, which is how a confirmation outlives its subject.
 *
 * `onBeforeNavigate` is deliberately not used: it fires before a document
 * identity exists to bind to. `onCommitted` is the earliest point at which the
 * browser can say both that the old document is gone and what the new one is.
 */
function invalidateApprovalsFor(tabId: number, why: string): void {
	// The store drops its own entries; the copies the panel rendered are this
	// module's to drop and nothing else will. Whatever is still pending after
	// the invalidation belonged to another tab, so the difference is exactly
	// what this discarded.
	const before = new Set(approvals.pendingKeys());
	approvals.invalidateTab(tabId);
	for (const binding of approvals.pendingKeys()) {
		before.delete(binding);
	}
	if (before.size === 0) {
		return;
	}
	for (const binding of before) {
		filed.delete(binding);
	}
	refreshBadge();
	announceChange(why);
}

chrome.tabs.onUpdated.addListener(
	(tabId: number, changeInfo: { status?: unknown }): void => {
		if (changeInfo.status !== "loading") {
			return;
		}
		invalidateApprovalsFor(tabId, "the tab navigated");
	},
);

chrome.tabs.onActivated.addListener((info: { tabId?: unknown }): void => {
	// Deliberately does not invalidate anything.
	//
	// The obvious thing to do here is to retire approvals for every tab the
	// person is no longer looking at. That was tried, and it is wrong: the
	// confirmation surface itself can be a tab, so reading the approval retires
	// the approval, and a person who checked a reference in another window loses
	// the question they were asked.
	//
	// Staleness is already handled where it is actually decidable. Navigation
	// discards the approvals bound to the document that is gone, and
	// `verifyAndConsume` re-derives every part of the binding from live values
	// at the moment of the click — so a card that went stale is refused, not
	// honoured, whatever the person was looking at when they clicked it.
	if (typeof info.tabId !== "number") {
		return;
	}
	refreshBadge();
});

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
		const panelOp = record.panel;
		if (typeof panelOp === "string") {
			try {
				sendResponse({ ok: true, result: panel(panelOp, record.args) });
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
			request = createInjectionRequest(record.handler, record.args);
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

/* ------------------------------------------------------------------ relay */

/**
 * What the daemon may ask this worker for.
 *
 * A closed map rather than a dispatch switch that takes a name: an unknown name
 * never reaches a function, so a hostile or confused caller cannot reach one by
 * spelling it.
 *
 * `activeTab` is here and not in `HANDLER_NAMES` on purpose. Those name the
 * functions this worker *injects into a page*, and each takes a `tabId` because
 * it has to. This one names the tab instead of being handed one, and touches no
 * page at all — putting it in that set would widen a meaning that is exact.
 */
const RELAY_HANDLERS = {
	activeTab: async (): Promise<unknown> => readActiveTab(),
	listTools: async (args: Record<string, unknown>): Promise<unknown> =>
		await handle({ handler: "listTools", args }),
	getTool: async (args: Record<string, unknown>): Promise<unknown> =>
		await handle({ handler: "getTool", args }),
	executeTool: async (args: Record<string, unknown>): Promise<unknown> =>
		await handle({ handler: "executeTool", args }),
} as const;

type RelayHandlerName = keyof typeof RELAY_HANDLERS;

async function dispatchRelay(
	name: unknown,
	args: Record<string, unknown>,
): Promise<unknown> {
	// `Object.hasOwn`, not `in`.
	//
	// `in` walks the prototype chain, so `"toString" in RELAY_HANDLERS` and
	// `"constructor" in RELAY_HANDLERS` are both true. The lookup then returns
	// `Object.prototype.toString` or `Object`, a real function that is not a
	// handler — and it runs, producing a value, which is exactly what the
	// comment above this map claims cannot happen. That value crosses `/result`
	// into `readToolOutcome`, where a string is by construction a completed
	// tool result: work that never ran, reported as work that did.
	//
	// The handler name arrives from another process, so the guard that decides
	// which functions are reachable has to be about the map, not about
	// everything the map inherits.
	if (typeof name !== "string" || !Object.hasOwn(RELAY_HANDLERS, name)) {
		throw new TypeError("unknown handler");
	}
	const fn = RELAY_HANDLERS[name as RelayHandlerName] as (
		args: Record<string, unknown>,
	) => Promise<unknown>;
	return await fn(args);
}

/**
 * Started at top level, not from an event.
 *
 * A Manifest V3 worker is created and destroyed constantly, and its top level
 * runs on every revival. Connecting here rather than on some particular event
 * means the bridge reattaches whenever the browser brings the worker back for
 * any reason, with nothing having to remember to ask.
 */
const relay = startRelay(async (request) => {
	return await dispatchRelay(request.handler, request.args);
});

// Exposed for tests driving the worker directly through Playwright. Not
// reachable from the page: a service worker's global is not a page global, and
// the manifest denies external connections. The panel reaches the worker over
// `chrome.runtime.sendMessage` and uses none of these.
//
// Approvals are filed by the worker from its own validated view, so there is
// nothing left for a test to file and nothing to reimplement the rule for.
Object.assign(globalThis as unknown as Record<string, unknown>, {
	__axHandle: handle,
	__axApprovals: approvals,
	__axPanel: panel,
	__axTrail: trail,
	__axRelay: relay,
	// Test-only: drop the commit record without stopping the worker.
	// Production reaches this state when a slow start misses `onCommitted`:
	// the tab is live, the map is empty, and no navigation follows to refill
	// it. Killing the worker through the debugger protocol reproduces it on
	// a local machine but hangs hosted runners — no close event, and an
	// evaluate that pends rather than rejecting — so the test that covers
	// the re-learn drives this instead. Like the entries above, it lives on
	// the worker global, which no page can reach.
	__axTestForgetDocuments: () => {
		documents.clear();
	},
});
