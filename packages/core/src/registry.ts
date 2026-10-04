// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import {
	invalidState,
	notAllowed,
	notSupported,
	unknownError,
} from "./errors.js";
import { fireToolActivated, fireToolCancel, fireToolChange } from "./events.js";
import {
	isAbortSignal,
	isAllowedToUse,
	isFullyActive,
	parseOriginList,
	warnDiagnostic,
} from "./gates.js";
import {
	assertValidArguments,
	parseInputSchema,
	serializeInputSchema,
} from "./schema.js";
import type {
	ModelContext,
	ModelContextExecuteToolOptions,
	ModelContextGetToolOptions,
	ModelContextRegisterToolOptions,
	ModelContextTool,
	ModelEventHandler,
	RegisteredTool,
	ToolExecuteCallback,
} from "./types.js";
import { toUSVString } from "./types.js";

interface StoredAnnotations {
	readonly readOnlyHint: boolean;
	readonly untrustedContentHint: boolean;
	readonly consequentialHint: boolean;
	readonly debugging: boolean;
}

interface ToolRecord {
	readonly name: string;
	readonly title: string | null;
	readonly description: string;
	readonly schemaJson: string | undefined;
	readonly execute: ToolExecuteCallback;
	readonly annotations: StoredAnnotations | null;
	readonly exposedOrigins: ReadonlyArray<string>;
	readonly cleanup?: (() => void) | undefined;
}

interface DocumentState {
	readonly document: Document;
	readonly context: ModelContextImpl;
	readonly tools: Map<string, ToolRecord>;
}

const states = new WeakMap<Document, DocumentState>();

export function stateOf(doc: Document): DocumentState | undefined {
	return states.get(doc);
}

export function ensureState(doc: Document): DocumentState {
	let state = states.get(doc);
	if (state === undefined) {
		state = {
			document: doc,
			context: new ModelContextImpl(doc),
			tools: new Map(),
		};
		states.set(doc, state);
	}
	return state;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The precondition pair every entry point enforces, in draft order, with the
 * specified errors. Shared so the root methods and the opt-in entry cannot
 * drift apart.
 */
export function checkCallerGates(doc: Document): void {
	if (!isFullyActive(doc)) {
		throw invalidState("inactive document");
	}
	if (!isAllowedToUse(doc)) {
		throw notAllowed("tools not allowed");
	}
}

export function readOptionsDict(options: unknown): Record<string, unknown> {
	const raw: unknown = options ?? {};
	if (typeof raw !== "object" || raw === null) {
		throw new TypeError("bad options");
	}
	return raw as Record<string, unknown>;
}

function readSignal(opts: Record<string, unknown>): AbortSignal | undefined {
	const raw: unknown = opts.signal;
	if (raw === undefined) {
		return undefined;
	}
	if (!isAbortSignal(raw)) {
		throw new TypeError("bad signal");
	}
	if (raw.aborted === true) {
		throw raw.reason;
	}
	return raw;
}

interface PendingExecution {
	readonly callerDocument: Document;
	readonly targetDocument: Document;
	readonly toolName: string;
	readonly controller: AbortController;
	readonly complete: (result: string | null) => void;
}

const pendingExecutions = new Map<number, PendingExecution>();

let nextExecutionId = 1;

function cancelExecution(uuid: number, pending: PendingExecution): void {
	pendingExecutions.delete(uuid);
	pending.controller.abort();
	const live = states.get(pending.targetDocument);
	if (live !== undefined) {
		fireToolCancel(live.context, pending.toolName);
	}
}

/**
 * Unloading-document cleanup: pending executions touching the destroyed
 * document settle per the draft — target gone completes false (the caller
 * rejects `UnknownError`), caller gone cancels, both gone just removes.
 */
export function handleDocumentUnload(doc: Document): void {
	for (const [uuid, pending] of pendingExecutions) {
		if (pending.callerDocument !== doc && pending.targetDocument !== doc) {
			continue;
		}
		const callerGone = pending.callerDocument === doc;
		const targetGone = pending.targetDocument === doc;
		if (targetGone && !callerGone) {
			pending.controller.abort();
			pending.complete(null);
		} else if (callerGone && !targetGone) {
			cancelExecution(uuid, pending);
		} else {
			pendingExecutions.delete(uuid);
		}
	}
}

function topDocument(doc: Document): Document {
	let current = doc;
	for (;;) {
		let frame: Element | null;
		try {
			frame = current.defaultView?.frameElement ?? null;
		} catch {
			return current;
		}
		if (frame === null) {
			return current;
		}
		let parent: Document;
		try {
			parent = frame.ownerDocument;
		} catch {
			return current;
		}
		if (parent === current) {
			return current;
		}
		current = parent;
	}
}

function checkName(raw: string, tools: Map<string, ToolRecord>): string {
	if (tools.has(raw)) {
		throw invalidState(`duplicate tool ${raw}`);
	}
	if (raw.length > 128 || !NAME_PATTERN.test(raw)) {
		throw invalidState("bad tool name");
	}
	return raw;
}

function readAnnotations(value: unknown): StoredAnnotations | null {
	if (value === undefined) {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("bad annotations");
	}
	const record = value as Record<string, unknown>;
	const flag = (key: string): boolean => {
		const flagValue = record[key];
		if (flagValue === undefined) {
			return false;
		}
		if (typeof flagValue !== "boolean") {
			throw new TypeError("annotations not booleans");
		}
		return flagValue;
	};
	return {
		readOnlyHint: flag("readOnlyHint"),
		untrustedContentHint: flag("untrustedContentHint"),
		consequentialHint: flag("consequentialHint"),
		debugging: flag("debugging"),
	};
}

/**
 * The origin to decide by. Hostless documents (about:blank, srcdoc) report a
 * null serialization while inheriting their embedder's origin, so callers
 * that know the parent pass it down; otherwise the frame tree is climbed.
 * Anything unreachable stays opaque. Ours: the draft names the Document
 * origin, which the platform does not expose for these documents.
 */
function effectiveOrigin(doc: Document): string {
	return effectiveOriginOf(doc, null);
}

function effectiveOriginOf(doc: Document, parent: string | null): string {
	let direct: string;
	try {
		direct = String(doc.location.origin ?? "null");
	} catch {
		direct = "null";
	}
	if (direct !== "null" && direct !== "") {
		return direct;
	}
	if (parent !== null) {
		return parent;
	}
	try {
		const frame = doc.defaultView?.frameElement ?? null;
		if (frame !== null) {
			return effectiveOrigin(frame.ownerDocument);
		}
	} catch {
		// Cross-origin embedders are unobservable: stay opaque.
	}
	return "null";
}

function sameOrigin(firstOrigin: string, secondOrigin: string): boolean {
	if (firstOrigin === "null" || secondOrigin === "null") {
		return false;
	}
	return firstOrigin === secondOrigin;
}

function isExposedTo(
	ownerOrigin: string,
	exposedOrigins: ReadonlyArray<string>,
	accessingOrigin: string,
): boolean {
	if (ownerOrigin !== "null" && ownerOrigin === accessingOrigin) {
		return true;
	}
	return exposedOrigins.some((allowed) => allowed === accessingOrigin);
}

interface TreeEntry {
	readonly document: Document;
	readonly origin: string;
}

function collectTree(top: Document): TreeEntry[] {
	const entries: TreeEntry[] = [];
	const seen = new Set<Document>();
	const visit = (doc: Document, parentOrigin: string | null): void => {
		if (seen.has(doc)) {
			return;
		}
		seen.add(doc);
		const origin = effectiveOriginOf(doc, parentOrigin);
		entries.push({ document: doc, origin });
		let frames: NodeListOf<HTMLIFrameElement>;
		try {
			frames = doc.querySelectorAll("iframe");
		} catch {
			return;
		}
		for (const frame of frames) {
			let child: Document | null = null;
			try {
				child = frame.contentDocument;
			} catch {
				continue;
			}
			if (child !== null) {
				visit(child, origin);
			}
		}
	};
	visit(top, null);
	return entries;
}

interface VisibleDoc {
	readonly document: Document;
	readonly origin: string;
	readonly state: DocumentState;
	readonly window: Window;
}

function collectVisibleDocs(top: Document): VisibleDoc[] {
	const visible: VisibleDoc[] = [];
	for (const { document: doc, origin } of collectTree(top)) {
		if (!isAllowedToUse(doc)) {
			continue;
		}
		const state = states.get(doc);
		if (state === undefined) {
			continue;
		}
		const win = doc.defaultView;
		if (win === null) {
			continue;
		}
		visible.push({ document: doc, origin, state, window: win });
	}
	return visible;
}

export class ModelContextImpl extends EventTarget implements ModelContext {
	#document: Document;
	#onToolChange: ModelEventHandler = null;
	#onToolActivated: ModelEventHandler = null;
	#onToolCancel: ModelEventHandler = null;

	constructor(doc: Document) {
		super();
		this.#document = doc;
	}

	get ontoolchange(): ModelEventHandler {
		return this.#onToolChange;
	}

	set ontoolchange(handler: ModelEventHandler) {
		this.#onToolChange = setHandler(
			this,
			"toolchange",
			() => this.#onToolChange,
			handler,
		);
	}

	get ontoolactivated(): ModelEventHandler {
		return this.#onToolActivated;
	}

	set ontoolactivated(handler: ModelEventHandler) {
		this.#onToolActivated = setHandler(
			this,
			"toolactivated",
			() => this.#onToolActivated,
			handler,
		);
	}

	get ontoolcancel(): ModelEventHandler {
		return this.#onToolCancel;
	}

	set ontoolcancel(handler: ModelEventHandler) {
		this.#onToolCancel = setHandler(
			this,
			"toolcancel",
			() => this.#onToolCancel,
			handler,
		);
	}

	async registerTool(
		tool: ModelContextTool,
		options?: ModelContextRegisterToolOptions | undefined,
	): Promise<undefined> {
		const owner = this.#document;
		checkCallerGates(owner);

		const rawTool: unknown = tool;
		if (typeof rawTool !== "object" || rawTool === null) {
			throw new TypeError("bad tool");
		}
		const input = rawTool as Record<string, unknown>;

		const rawName: unknown = input.name;
		if (rawName === undefined) {
			throw new TypeError("name required");
		}
		const state = ensureState(owner);
		const name = checkName(String(rawName), state.tools);

		const rawDescription: unknown = input.description;
		if (rawDescription === undefined) {
			throw new TypeError("description required");
		}
		const description = String(rawDescription);
		if (description === "") {
			throw invalidState("empty description");
		}

		const schemaJson = serializeInputSchema(input.inputSchema);

		const rawTitle: unknown = input.title;
		const title = rawTitle === undefined ? null : toUSVString(rawTitle);

		const rawExecute: unknown = input.execute;
		if (typeof rawExecute !== "function") {
			throw new TypeError("bad execute");
		}

		const annotations = readAnnotations(input.annotations);

		const opts = readOptionsDict(options);

		const signal = readSignal(opts);

		const rawExposed: unknown = opts.exposedTo;
		const exposedOrigins =
			rawExposed === undefined ? [] : parseOriginList(rawExposed, "exposedTo");

		// Removal detaches the listener, so an unregister through any path
		// never leaves a stale abort subscription behind.
		let removeRegAbort: (() => void) | undefined;
		if (signal !== undefined) {
			const onAbort = (): void => {
				if (state.tools.get(name) === record) {
					unregisterRecord(owner, name);
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeRegAbort = (): void => {
				signal.removeEventListener("abort", onAbort);
			};
		}

		const record: ToolRecord = {
			name,
			title,
			description,
			schemaJson,
			execute: rawExecute as ToolExecuteCallback,
			annotations,
			exposedOrigins,
			cleanup: removeRegAbort,
		};
		state.tools.set(name, record);

		notifyToolChange(owner, exposedOrigins);
		return undefined;
	}

	async getTools(
		options?: ModelContextGetToolOptions | undefined,
	): Promise<RegisteredTool[]> {
		const requestor = this.#document;
		checkCallerGates(requestor);

		const opts = readOptionsDict(options);
		const rawFrom: unknown = opts.fromOrigins;
		const fromOrigins =
			rawFrom === undefined ? [] : parseOriginList(rawFrom, "fromOrigins");

		return collectRegisteredTools(requestor, fromOrigins);
	}

	async executeTool(
		tool: RegisteredTool,
		inputObject?: unknown,
		options?: ModelContextExecuteToolOptions | undefined,
	): Promise<string> {
		const caller = this.#document;
		checkCallerGates(caller);

		const rawTool: unknown = tool;
		if (typeof rawTool !== "object" || rawTool === null) {
			throw new TypeError("bad tool");
		}
		const given = rawTool as Record<string, unknown>;

		const rawOrigin: unknown = given.origin;
		const expectedOrigin = rawOrigin === undefined ? "" : String(rawOrigin);
		let expected: URL;
		try {
			expected = new URL(expectedOrigin);
		} catch {
			throw notSupported("bad tool origin");
		}
		if (expected.origin === "null") {
			throw notSupported("opaque tool origin");
		}

		// Omitted arguments default to {}. Upstream:
		// webmcp/imperative/object-arguments.https.html.
		const args: unknown = inputObject === undefined ? {} : inputObject;
		if (typeof args !== "object" || args === null) {
			throw new TypeError("bad arguments");
		}
		const inputArguments: unknown = JSON.stringify(args);
		if (typeof inputArguments !== "string") {
			throw new TypeError("arguments unserializable");
		}

		const opts = readOptionsDict(options);
		const execSignal = readSignal(opts);

		let target: Document;
		try {
			const targetWindow = given.window as Window;
			target = targetWindow.document;
		} catch {
			throw unknownError("bad tool target");
		}
		if (typeof target !== "object" || target === null) {
			throw unknownError("bad tool target");
		}

		if (topDocument(caller) !== topDocument(target)) {
			throw unknownError("foreign tool target");
		}

		// Authority can change after registration: re-check the target's
		// eligibility at invocation time. A target that fails its own gates
		// is indistinguishable from a missing tool to the caller.
		try {
			checkCallerGates(target);
		} catch {
			throw unknownError("target not eligible");
		}

		const toolName =
			given.name === undefined ? "undefined" : String(given.name);
		const liveOrigin = effectiveOrigin(target);
		if (liveOrigin !== expected.origin) {
			throw unknownError("tool origin mismatch");
		}

		const targetState = states.get(target);
		const record = targetState?.tools.get(toolName);
		if (record === undefined) {
			throw unknownError("unknown tool");
		}

		const callerOrigin = effectiveOrigin(caller);
		if (!isExposedTo(liveOrigin, record.exposedOrigins, callerOrigin)) {
			throw unknownError("tool not exposed");
		}

		const uuid = nextExecutionId++;
		const invocation = {
			arguments: inputArguments,
			name: toolName,
			target,
		};

		return new Promise<string>((resolveCaller, rejectCaller) => {
			const controller = new AbortController();
			let onAbort: (() => void) | undefined;
			const tracker: PendingExecution = {
				callerDocument: caller,
				targetDocument: target,
				toolName,
				controller,
				complete: (result: string | null): void => {
					if (!pendingExecutions.has(uuid)) {
						return;
					}
					pendingExecutions.delete(uuid);
					if (onAbort !== undefined && execSignal !== undefined) {
						execSignal.removeEventListener("abort", onAbort);
					}
					if (result !== null) {
						resolveCaller(result);
					} else {
						rejectCaller(unknownError("tool did not complete"));
					}
				},
			};
			pendingExecutions.set(uuid, tracker);

			if (execSignal !== undefined) {
				onAbort = (): void => {
					rejectCaller(execSignal.reason);
					const pending = pendingExecutions.get(uuid);
					if (pending === undefined) {
						return;
					}
					cancelExecution(uuid, pending);
				};
				execSignal.addEventListener("abort", onAbort, { once: true });
			}

			void runToolCall(invocation, controller.signal, tracker.complete).catch(
				() => {
					tracker.complete(null);
				},
			);
		});
	}
}

interface ToolInvocation {
	readonly arguments: string;
	readonly name: string;
	readonly target: Document;
}

async function runToolCall(
	invocation: ToolInvocation,
	localSignal: AbortSignal,
	complete: (result: string | null) => void,
): Promise<void> {
	let parsed: unknown;
	let current: ToolRecord;
	try {
		parsed = JSON.parse(invocation.arguments) as unknown;
		if (typeof parsed !== "object" || parsed === null) {
			throw new TypeError("bad arguments");
		}
		// Re-validate against the current definition so an
		// unregister/re-register race cannot check new arguments against an old
		// schema. Ours, not draft-derived: the draft re-reads existence only.
		const liveRecord = states
			.get(invocation.target)
			?.tools.get(invocation.name);
		if (liveRecord === undefined) {
			throw new TypeError("unknown tool");
		}
		current = liveRecord;
		assertValidArguments(parsed, current.schemaJson);
	} catch {
		complete(null);
		return;
	}
	const live = states.get(invocation.target);
	if (live !== undefined) {
		fireToolActivated(live.context, invocation.name);
	}
	let value: unknown;
	try {
		value = await current.execute(parsed, { signal: localSignal });
	} catch (error) {
		warnDiagnostic(
			`tool failed: ${error instanceof Error ? error.message : "unknown reason"}`,
		);
		complete(null);
		return;
	}
	let serialized: string | undefined;
	try {
		const json: unknown = JSON.stringify(value);
		serialized = typeof json === "string" ? json : undefined;
	} catch {
		serialized = undefined;
	}
	if (serialized === undefined) {
		complete(null);
		return;
	}
	complete(serialized);
}

export function unregisterRecord(doc: Document, name: string): boolean {
	const state = states.get(doc);
	if (state === undefined) {
		return false;
	}
	const record = state.tools.get(name);
	if (record === undefined) {
		return false;
	}
	state.tools.delete(name);
	record.cleanup?.();
	notifyToolChange(doc, record.exposedOrigins);
	return true;
}

/**
 * Sync collection behind `getTools`, shared with the opt-in entry so the
 * exposure and ordering rules cannot drift between the two paths.
 */
export function collectRegisteredTools(
	requestor: Document,
	fromOrigins: ReadonlyArray<string>,
): RegisteredTool[] {
	const callerOrigin = effectiveOrigin(requestor);
	const listed: RegisteredTool[] = [];

	for (const {
		document: targetDocument,
		origin: targetOrigin,
		state: targetState,
		window: targetWindow,
	} of collectVisibleDocs(topDocument(requestor))) {
		const ownerRequested =
			targetDocument === requestor ||
			sameOrigin(targetOrigin, callerOrigin) ||
			fromOrigins.includes(targetOrigin);
		if (!ownerRequested) {
			continue;
		}
		for (const record of targetState.tools.values()) {
			if (
				targetDocument !== requestor &&
				!isExposedTo(targetOrigin, record.exposedOrigins, callerOrigin)
			) {
				continue;
			}
			listed.push({
				name: record.name,
				title: record.title ?? "",
				description: record.description,
				...(record.schemaJson === undefined
					? {}
					: { inputSchema: parseInputSchema(record.schemaJson) }),
				window: targetWindow,
				origin: targetOrigin,
				...(record.annotations === null
					? {}
					: { annotations: { ...record.annotations } }),
			});
		}
	}

	listed.sort((first, second) =>
		first.name < second.name ? -1 : first.name > second.name ? 1 : 0,
	);
	return listed;
}

function notifyToolChange(
	owner: Document,
	exposedOrigins: ReadonlyArray<string>,
): void {
	const ownerOrigin = effectiveOrigin(owner);
	for (const {
		document: targetDocument,
		origin: targetOrigin,
		state: targetState,
	} of collectVisibleDocs(topDocument(owner))) {
		if (
			targetDocument !== owner &&
			!isExposedTo(ownerOrigin, exposedOrigins, targetOrigin)
		) {
			continue;
		}
		queueToolChange(targetState.context);
	}
}

/**
 * Task-source delivery for change notification. The draft queues each
 * notification as a task, so listeners never run inside the registering call
 * and cannot re-enter it. MessageChannel posts a real task without timers;
 * where the platform hides it, a microtask is the closest ordering available.
 */
function queueToolChange(target: EventTarget): void {
	if (typeof MessageChannel === "function") {
		const channel = new MessageChannel();
		channel.port1.onmessage = (): void => {
			channel.port1.close();
			channel.port2.close();
			fireToolChange(target);
		};
		channel.port2.postMessage(undefined);
	} else {
		queueMicrotask(() => fireToolChange(target));
	}
}

/**
 * Attribute-handler storage. Each event type gets one internal wrapper
 * listener per target, registered on the first non-null assignment. The
 * wrapper dispatches to the currently stored handler, so non-function values
 * collapse to null without throwing, a handler never deduplicates or removes
 * an explicit listener for the same function, and replacement never moves
 * the handler within the listener list.
 */
const handlerWrappers = new WeakMap<
	EventTarget,
	Map<string, (event: Event) => void>
>();

function setHandler(
	target: EventTarget,
	type: string,
	read: () => ModelEventHandler,
	next: ModelEventHandler,
): ModelEventHandler {
	const handler = typeof next === "function" ? next : null;
	let byType = handlerWrappers.get(target);
	let wrapper = byType?.get(type);
	if (wrapper === undefined) {
		wrapper = (event: Event): void => {
			const live = read();
			if (live !== null) {
				live(event);
			}
		};
		if (byType === undefined) {
			byType = new Map();
			handlerWrappers.set(target, byType);
		}
		byType.set(type, wrapper);
		target.addEventListener(type, wrapper);
	}
	return handler;
}
