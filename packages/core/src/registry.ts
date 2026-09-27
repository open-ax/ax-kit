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
	readonly schemaJson: string;
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

interface PendingExecution {
	readonly callerDocument: Document;
	readonly targetDocument: Document;
	readonly toolName: string;
	readonly controller: AbortController;
	readonly complete: (result: string | null, success: boolean) => void;
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
	for (const [uuid, pending] of [...pendingExecutions]) {
		if (pending.callerDocument !== doc && pending.targetDocument !== doc) {
			continue;
		}
		if (pending.targetDocument === doc && pending.callerDocument !== doc) {
			pending.complete(null, false);
		} else if (
			pending.callerDocument === doc &&
			pending.targetDocument !== doc
		) {
			cancelExecution(uuid, pending);
		} else {
			pendingExecutions.delete(uuid);
		}
	}
}

function topDocument(doc: Document): Document {
	let current = doc;
	for (;;) {
		const frame = current.defaultView?.frameElement;
		if (frame === null || frame === undefined) {
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
	if (raw === "" || raw.length > 128 || !NAME_PATTERN.test(raw)) {
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
		readOnlyHint: Boolean(record.readOnlyHint ?? false),
		untrustedContentHint: Boolean(record.untrustedContentHint ?? false),
		consequentialHint: Boolean(record.consequentialHint ?? false),
		debugging: Boolean(record.debugging ?? false),
	};
}

function originOf(doc: Document): string {
	return doc.location.origin;
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

function collectDocuments(root: Document): Document[] {
	const found: Document[] = [root];
	const frames = root.querySelectorAll("iframe");
	for (const frame of frames) {
		let child: Document | null = null;
		try {
			child = frame.contentDocument;
		} catch {
			continue;
		}
		if (child !== null && !found.includes(child)) {
			found.push(...collectDocuments(child));
		}
	}
	return found;
}

function listedAnnotations(
	stored: StoredAnnotations | null,
): ToolAnnotations | undefined {
	if (stored === null) {
		return undefined;
	}
	return {
		readOnlyHint: stored.readOnlyHint,
		untrustedContentHint: stored.untrustedContentHint,
		consequentialHint: stored.consequentialHint,
		debugging: stored.debugging,
	};
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

	get ownerDocument(): Document {
		return this.#document;
	}

	unregisterToolRecord(name: string): {
		removed: boolean;
		exposedOrigins: ReadonlyArray<string>;
	} {
		const state = states.get(this.#document);
		if (state === undefined) {
			return { removed: false, exposedOrigins: [] };
		}
		const record = state.tools.get(name);
		if (record === undefined) {
			return { removed: false, exposedOrigins: [] };
		}
		state.tools.delete(name);
		return { removed: true, exposedOrigins: record.exposedOrigins };
	}

	async registerTool(
		tool: ModelContextTool,
		options?: ModelContextRegisterToolOptions | undefined,
	): Promise<undefined> {
		const owner = this.#document;
		if (!isFullyActive(owner)) {
			throw invalidState("the document is not fully active");
		}
		if (!isOriginKeyed(owner)) {
			warnDiagnostic(originKeyedDiagnostic(owner));
			throw securityError("the agent cluster is not origin-keyed");
		}
		if (!isAllowedToUse(owner)) {
			throw notAllowed("the tools feature is not allowed");
		}

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

		const schemaJson = serializeInputSchema(input.inputSchema) ?? "";

		const rawTitle: unknown = input.title;
		const title = rawTitle === undefined ? null : toUSVString(rawTitle);

		const rawExecute: unknown = input.execute;
		if (typeof rawExecute !== "function") {
			throw new TypeError("tool execute must be a function");
		}

		const annotations = readAnnotations(input.annotations);

		const rawOptions: unknown = options ?? {};
		if (typeof rawOptions !== "object" || rawOptions === null) {
			throw new TypeError("options must be an object");
		}
		const opts = rawOptions as Record<string, unknown>;

		const rawSignal: unknown = opts.signal;
		if (rawSignal !== undefined && !isAbortSignal(rawSignal)) {
			throw new TypeError("options signal must be an AbortSignal");
		}
		const signal = rawSignal;
		if (signal?.aborted === true) {
			throw signal.reason;
		}

		const rawExposed: unknown = opts.exposedTo;
		const exposedOrigins =
			rawExposed === undefined ? [] : parseOriginList(rawExposed, "exposedTo");

		state.tools.set(name, {
			name,
			title,
			description,
			schemaJson,
			execute: rawExecute as ToolExecuteCallback,
			annotations,
			exposedOrigins,
		});

		if (signal !== undefined) {
			signal.addEventListener(
				"abort",
				() => {
					unregisterTool(this, name);
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
		if (!isFullyActive(requestor)) {
			throw invalidState("the document is not fully active");
		}
		if (!isOriginKeyed(requestor)) {
			warnDiagnostic(originKeyedDiagnostic(requestor));
			throw securityError("the agent cluster is not origin-keyed");
		}
		if (!isAllowedToUse(requestor)) {
			throw notAllowed("the tools feature is not allowed");
		}

		const rawOptions: unknown = options ?? {};
		if (typeof rawOptions !== "object" || rawOptions === null) {
			throw new TypeError("options must be an object");
		}
		const opts = rawOptions as Record<string, unknown>;
		const rawFrom: unknown = opts.fromOrigins;
		const fromOrigins =
			rawFrom === undefined ? [] : parseOriginList(rawFrom, "fromOrigins");

		const callerOrigin = originOf(requestor);
		const listed: RegisteredTool[] = [];

		for (const targetDocument of collectDocuments(requestor)) {
			if (!isAllowedToUse(targetDocument)) {
				continue;
			}
			const targetOrigin = originOf(targetDocument);
			const ownerRequested =
				targetDocument === requestor ||
				sameOrigin(targetOrigin, callerOrigin) ||
				fromOrigins.includes(targetOrigin);
			if (!ownerRequested) {
				continue;
			}
			const targetState = states.get(targetDocument);
			if (targetState === undefined) {
				continue;
			}
			const targetWindow = targetDocument.defaultView;
			if (targetWindow === null) {
				continue;
			}
			for (const record of targetState.tools.values()) {
				const ownTools =
					targetDocument === requestor && targetOrigin === callerOrigin;
				if (
					!ownTools &&
					!isExposedTo(targetOrigin, record.exposedOrigins, callerOrigin)
				) {
					continue;
				}
				listed.push({
					name: record.name,
					title: record.title ?? "",
					description: record.description,
					...(record.schemaJson === ""
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

	async executeTool(
		tool: RegisteredTool,
		inputObject?: unknown,
		options?: ModelContextExecuteToolOptions | undefined,
	): Promise<string> {
		const caller = this.#document;
		if (!isFullyActive(caller)) {
			throw invalidState("the document is not fully active");
		}
		if (!isOriginKeyed(caller)) {
			warnDiagnostic(originKeyedDiagnostic(caller));
			throw securityError("the agent cluster is not origin-keyed");
		}
		if (!isAllowedToUse(caller)) {
			throw notAllowed("the tools feature is not allowed");
		}

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

		if (typeof inputObject !== "object" || inputObject === null) {
			throw new TypeError("tool arguments must be an object");
		}
		const inputArguments: unknown = JSON.stringify(inputObject);
		if (typeof inputArguments !== "string") {
			throw new TypeError("tool arguments cannot be serialized");
		}

		const rawOptions: unknown = options ?? {};
		if (typeof rawOptions !== "object" || rawOptions === null) {
			throw new TypeError("options must be an object");
		}
		const execSignal: unknown = (rawOptions as Record<string, unknown>).signal;
		if (execSignal !== undefined && !isAbortSignal(execSignal)) {
			throw new TypeError("options signal must be an AbortSignal");
		}
		if (execSignal?.aborted === true) {
			throw execSignal.reason;
		}

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
		const liveOrigin = originOf(target);
		if (liveOrigin !== expected.origin) {
			throw unknownError("the tool origin does not match");
		}

		const targetState = states.get(target);
		const record = targetState?.tools.get(toolName);
		if (record === undefined) {
			throw unknownError("no such tool is registered");
		}

		const callerOrigin = originOf(caller);
		const ownCall = target === caller && liveOrigin === expected.origin;
		if (
			!ownCall &&
			!isExposedTo(liveOrigin, record.exposedOrigins, callerOrigin)
		) {
			throw unknownError("the tool is not exposed to this origin");
		}

		const uuid = nextExecutionId;
		nextExecutionId += 1;
		const invocation = {
			arguments: inputArguments,
			name: toolName,
			record,
			target,
		};

		return new Promise<string>((resolveCaller, rejectCaller) => {
			const controller = new AbortController();
			const record: PendingExecution = {
				callerDocument: caller,
				targetDocument: target,
				toolName,
				controller,
				complete: (result: string | null, success: boolean): void => {
					if (!pendingExecutions.has(uuid)) {
						return;
					}
					pendingExecutions.delete(uuid);
					if (success && result !== null) {
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
					record.complete(null, false);
				},
			);
		});
	}
}

interface ToolInvocation {
	readonly arguments: string;
	readonly name: string;
	readonly record: ToolRecord;
	readonly target: Document;
}

async function runToolCall(
	invocation: ToolInvocation,
	localSignal: AbortSignal,
	complete: (result: string | null, success: boolean) => void,
): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(invocation.arguments) as unknown;
	} catch {
		complete(null, false);
		return;
	}
	if (typeof parsed !== "object" || parsed === null) {
		complete(null, false);
		return;
	}
	// Re-validate against the current definition so an
	// unregister/re-register race cannot check new arguments against an old
	// schema. Ours, not draft-derived: the draft re-reads existence only.
	const current = states.get(invocation.target)?.tools.get(invocation.name);
	if (current === undefined) {
		complete(null, false);
		return;
	}
	try {
		assertValidArguments(
			parsed,
			current.schemaJson === "" ? undefined : current.schemaJson,
		);
	} catch {
		complete(null, false);
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
		complete(null, false);
		return;
	}
	let serialized: unknown;
	try {
		serialized = JSON.stringify(value);
	} catch {
		complete(null, false);
		return;
	}
	if (typeof serialized !== "string") {
		complete(null, false);
		return;
	}
	complete(serialized, true);
}

export function unregisterTool(context: ModelContextImpl, name: string): void {
	const { removed, exposedOrigins } = context.unregisterToolRecord(name);
	if (!removed) {
		return;
	}
	notifyToolChange(context.ownerDocument, exposedOrigins);
}

export function notifyToolChange(
	owner: Document,
	exposedOrigins: ReadonlyArray<string>,
): void {
	const ownerOrigin = originOf(owner);
	for (const targetDocument of collectDocuments(owner)) {
		if (!isAllowedToUse(targetDocument)) {
			continue;
		}
		const targetOrigin = originOf(targetDocument);
		const ownDocument =
			targetDocument === owner && targetOrigin === ownerOrigin;
		if (
			!ownDocument &&
			!isExposedTo(ownerOrigin, exposedOrigins, targetOrigin)
		) {
			continue;
		}
		const targetState = states.get(targetDocument);
		if (targetState === undefined) {
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
