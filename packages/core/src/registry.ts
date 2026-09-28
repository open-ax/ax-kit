// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import {
	invalidState,
	notAllowed,
	notSupported,
	securityError,
	unknownError,
} from "./errors.js";
import { fireToolActivated, fireToolCancel, fireToolChange } from "./events.js";
import {
	isAbortSignal,
	isAllowedToUse,
	isFullyActive,
	isOriginKeyed,
	originKeyedDiagnostic,
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
	ToolAnnotations,
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
 * The precondition triple every entry point enforces, in draft order, with
 * the specified errors. Shared so the root methods and the opt-in entry
 * cannot drift apart.
 */
export function checkCallerGates(doc: Document): void {
	if (!isFullyActive(doc)) {
		throw invalidState("the document is not fully active");
	}
	if (!isOriginKeyed(doc)) {
		warnDiagnostic(originKeyedDiagnostic(doc));
		throw securityError("the agent cluster is not origin-keyed");
	}
	if (!isAllowedToUse(doc)) {
		throw notAllowed("the tools feature is not allowed");
	}
}

export function readOptionsDict(options: unknown): Record<string, unknown> {
	const raw: unknown = options ?? {};
	if (typeof raw !== "object" || raw === null) {
		throw new TypeError("options must be an object");
	}
	return raw as Record<string, unknown>;
}

export function readSignal(
	opts: Record<string, unknown>,
): AbortSignal | undefined {
	const raw: unknown = opts.signal;
	if (raw === undefined) {
		return undefined;
	}
	if (!isAbortSignal(raw)) {
		throw new TypeError("options signal must be an AbortSignal");
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

function allocExecutionId(): number {
	return nextExecutionId++;
}

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
		throw invalidState(`a tool named ${raw} is already registered`);
	}
	if (raw.length > 128 || !NAME_PATTERN.test(raw)) {
		throw invalidState("tool name must be 1-128 ASCII alphanumerics, _, -, .");
	}
	return raw;
}

function readAnnotations(value: unknown): StoredAnnotations | null {
	if (value === undefined) {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("tool annotations must be an object");
	}
	const record = value as Record<string, unknown>;
	return {
		readOnlyHint: readAnnotationFlag(record, "readOnlyHint"),
		untrustedContentHint: readAnnotationFlag(record, "untrustedContentHint"),
		consequentialHint: readAnnotationFlag(record, "consequentialHint"),
		debugging: readAnnotationFlag(record, "debugging"),
	};
}

function readAnnotationFlag(
	record: Record<string, unknown>,
	key: string,
): boolean {
	const value = record[key];
	if (value === undefined) {
		return false;
	}
	if (typeof value !== "boolean") {
		throw new TypeError("tool annotations must be booleans");
	}
	return value;
}

function ownOrigin(doc: Document): string {
	try {
		return String(doc.location.origin ?? "null");
	} catch {
		return "null";
	}
}

/**
 * The origin to decide by. Hostless documents (about:blank, srcdoc) report a
 * null serialization while inheriting their embedder's origin, so callers
 * that know the parent pass it down; otherwise the frame tree is climbed.
 * Anything unreachable stays opaque. Ours: the draft names the Document
 * origin, which the platform does not expose for these documents.
 */
export function effectiveOrigin(doc: Document): string {
	return effectiveOriginOf(doc, null);
}

function effectiveOriginOf(doc: Document, parent: string | null): string {
	const direct = ownOrigin(doc);
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

function listedAnnotations(
	stored: StoredAnnotations | null,
): ToolAnnotations | undefined {
	if (stored === null) {
		return undefined;
	}
	return { ...stored };
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
			this.#onToolChange,
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
			this.#onToolActivated,
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
			this.#onToolCancel,
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
			throw new TypeError("tool must be an object");
		}
		const input = rawTool as Record<string, unknown>;

		const rawName: unknown = input.name;
		if (rawName === undefined) {
			throw new TypeError("tool name is required");
		}
		const state = ensureState(owner);
		const name = checkName(String(rawName), state.tools);

		const rawDescription: unknown = input.description;
		if (rawDescription === undefined) {
			throw new TypeError("tool description is required");
		}
		const description = String(rawDescription);
		if (description === "") {
			throw invalidState("tool description must not be empty");
		}

		const schemaJson = serializeInputSchema(input.inputSchema);

		const rawTitle: unknown = input.title;
		const title = rawTitle === undefined ? null : toUSVString(rawTitle);

		const rawExecute: unknown = input.execute;
		if (typeof rawExecute !== "function") {
			throw new TypeError("tool execute must be a function");
		}

		const annotations = readAnnotations(input.annotations);

		const opts = readOptionsDict(options);

		const signal = readSignal(opts);

		const rawExposed: unknown = opts.exposedTo;
		const exposedOrigins =
			rawExposed === undefined ? [] : parseOriginList(rawExposed, "exposedTo");

		const record: ToolRecord = {
			name,
			title,
			description,
			schemaJson,
			execute: rawExecute as ToolExecuteCallback,
			annotations,
			exposedOrigins,
		};
		state.tools.set(name, record);

		if (signal !== undefined) {
			signal.addEventListener(
				"abort",
				() => {
					if (state.tools.get(name) === record) {
						unregisterRecord(owner, name);
					}
				},
				{ once: true },
			);
		}

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
			throw new TypeError("tool must be an object");
		}
		const given = rawTool as Record<string, unknown>;

		const rawOrigin: unknown = given.origin;
		const expectedOrigin = rawOrigin === undefined ? "" : String(rawOrigin);
		let expected: URL;
		try {
			expected = new URL(expectedOrigin);
		} catch {
			throw notSupported("the tool origin cannot be parsed");
		}
		if (expected.origin === "null") {
			throw notSupported("the tool origin is opaque");
		}

		// Omitted arguments default to {}. Upstream:
		// webmcp/imperative/object-arguments.https.html.
		const args: unknown = inputObject === undefined ? {} : inputObject;
		if (typeof args !== "object" || args === null) {
			throw new TypeError("tool arguments must be an object");
		}
		const inputArguments: unknown = JSON.stringify(args);
		if (typeof inputArguments !== "string") {
			throw new TypeError("tool arguments cannot be serialized");
		}

		const opts = readOptionsDict(options);
		const execSignal = readSignal(opts);

		let target: Document;
		try {
			const targetWindow = given.window as Window;
			target = targetWindow.document;
		} catch {
			throw unknownError("the tool target cannot be established");
		}
		if (typeof target !== "object" || target === null) {
			throw unknownError("the tool target cannot be established");
		}

		if (topDocument(caller) !== topDocument(target)) {
			throw unknownError("the tool lives in another hierarchy");
		}

		const toolName =
			given.name === undefined ? "undefined" : String(given.name);
		const liveOrigin = effectiveOrigin(target);
		if (liveOrigin !== expected.origin) {
			throw unknownError("the tool origin does not match");
		}

		const targetState = states.get(target);
		const record = targetState?.tools.get(toolName);
		if (record === undefined) {
			throw unknownError("no such tool is registered");
		}

		const callerOrigin = effectiveOrigin(caller);
		if (!isExposedTo(liveOrigin, record.exposedOrigins, callerOrigin)) {
			throw unknownError("the tool is not exposed to this origin");
		}

		const uuid = allocExecutionId();
		const invocation = {
			arguments: inputArguments,
			name: toolName,
			target,
		};

		return new Promise<string>((resolveCaller, rejectCaller) => {
			const controller = new AbortController();
			const record: PendingExecution = {
				callerDocument: caller,
				targetDocument: target,
				toolName,
				controller,
				complete: (result: string | null): void => {
					if (!pendingExecutions.has(uuid)) {
						return;
					}
					pendingExecutions.delete(uuid);
					if (result !== null) {
						resolveCaller(result);
					} else {
						rejectCaller(unknownError("tool execution did not complete"));
					}
				},
			};
			pendingExecutions.set(uuid, record);

			if (execSignal !== undefined) {
				execSignal.addEventListener(
					"abort",
					() => {
						rejectCaller(execSignal.reason);
						const pending = pendingExecutions.get(uuid);
						if (pending === undefined) {
							return;
						}
						cancelExecution(uuid, pending);
					},
					{ once: true },
				);
			}

			void runToolCall(invocation, controller.signal, record.complete).catch(
				() => {
					record.complete(null);
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
			throw new TypeError("tool arguments must be an object");
		}
		// Re-validate against the current definition so an
		// unregister/re-register race cannot check new arguments against an old
		// schema. Ours, not draft-derived: the draft re-reads existence only.
		const liveRecord = states
			.get(invocation.target)
			?.tools.get(invocation.name);
		if (liveRecord === undefined) {
			throw new TypeError("no such tool is registered");
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
			`tool execution failed: ${error instanceof Error ? error.message : "unknown reason"}`,
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

export function unregisterRecord(
	doc: Document,
	name: string,
): { removed: boolean; exposedOrigins: ReadonlyArray<string> } {
	const state = states.get(doc);
	if (state === undefined) {
		return { removed: false, exposedOrigins: [] };
	}
	const record = state.tools.get(name);
	if (record === undefined) {
		return { removed: false, exposedOrigins: [] };
	}
	state.tools.delete(name);
	notifyToolChange(doc, record.exposedOrigins);
	return { removed: true, exposedOrigins: record.exposedOrigins };
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
					: { annotations: listedAnnotations(record.annotations) }),
			});
		}
	}

	listed.sort((first, second) =>
		first.name < second.name ? -1 : first.name > second.name ? 1 : 0,
	);
	return listed;
}

export function notifyToolChange(
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
		fireToolChange(targetState.context);
	}
}

function setHandler(
	target: EventTarget,
	type: string,
	current: ModelEventHandler,
	next: ModelEventHandler,
): ModelEventHandler {
	if (next !== null && typeof next !== "function") {
		throw new TypeError(`on${type} must be a function or null`);
	}
	if (current !== null) {
		target.removeEventListener(type, current);
	}
	if (next !== null) {
		target.addEventListener(type, next);
	}
	return next;
}
