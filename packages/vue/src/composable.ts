// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { Ref } from "vue";
import { onMounted, onUnmounted, shallowRef, watch } from "vue";
import type {
	AxExecuteCallback,
	AxModelContextLike,
	AxToolDefinition,
} from "./types.js";

export interface AxToolHandle {
	readonly supported: Ref<boolean>;
	readonly registered: Ref<boolean>;
	readonly error: Ref<Error | DOMException | null>;
}

function hasWindow(): boolean {
	return typeof window !== "undefined" && typeof document !== "undefined";
}

function surfaceOf(doc: Document): AxModelContextLike | undefined {
	const raw = doc as unknown as Record<string, unknown>;
	const candidate = raw.modelContext;
	if (typeof candidate !== "object" || candidate === null) {
		return undefined;
	}
	const register = (candidate as Record<string, unknown>).registerTool;
	if (typeof register !== "function") {
		return undefined;
	}
	return candidate as AxModelContextLike;
}

export function isAxSupported(doc: Document | undefined): boolean {
	if (doc === undefined) {
		return false;
	}
	if (!hasWindow()) {
		return false;
	}
	return surfaceOf(doc) !== undefined;
}

function safeJson(value: unknown): string {
	try {
		const text: unknown = JSON.stringify(value === undefined ? null : value);
		return typeof text === "string" ? text : "unserializable";
	} catch {
		return "unserializable";
	}
}

export function snapshotIdentity(tool: AxToolDefinition): string {
	return `${tool.name}|${tool.description}|${tool.title ?? ""}|${safeJson(tool.inputSchema)}|${safeJson(tool.annotations ?? null)}|${safeJson(tool.exposedTo ?? null)}`;
}

function isDuplicateName(error: unknown): boolean {
	return error instanceof DOMException && error.name === "InvalidStateError";
}

function nextTask(): Promise<void> {
	if (typeof MessageChannel === "function") {
		return new Promise<void>((resolve) => {
			const channel = new MessageChannel();
			channel.port1.onmessage = (): void => {
				channel.port1.close();
				channel.port2.close();
				resolve();
			};
			channel.port2.postMessage(undefined);
		});
	}
	return Promise.resolve();
}

async function quiesce(): Promise<void> {
	await Promise.resolve();
	await nextTask();
}

/**
 * Register a tool for the lifetime of the calling component. Setup builds
 * only the inert handle plus guard; registration lives in the client mount
 * hook with teardown aborting it, so availability tracks component lifetime.
 * The registered callback forwards to a latest-handler mailbox while
 * identity change aborts then registers with tolerance for transient
 * duplicate-name rejection.
 */
export function useAxTool(tool: AxToolDefinition): AxToolHandle {
	const supported = shallowRef(true);
	const registered = shallowRef(false);
	const error: Ref<Error | DOMException | null> = shallowRef(null);

	if (!hasWindow()) {
		supported.value = false;
		return { supported, registered, error };
	}

	const handlerRef: { current: AxExecuteCallback } = { current: tool.execute };
	let controller: AbortController | undefined;
	let cancelled = false;
	let settled = false;

	const stableExecute: AxExecuteCallback = (args, opts) =>
		handlerRef.current(args, opts);

	async function register(
		target: AxToolDefinition,
		signal: AbortSignal,
		attempt: number,
	): Promise<void> {
		const surface = surfaceOf(document);
		if (surface === undefined) {
			if (!settled) {
				settled = true;
				supported.value = false;
			}
			return;
		}
		try {
			await surface.registerTool(
				{
					name: target.name,
					title: target.title,
					description: target.description,
					inputSchema: target.inputSchema,
					execute: stableExecute,
					annotations: target.annotations,
				},
				{ exposedTo: target.exposedTo, signal },
			);
			if (!cancelled && !settled) {
				settled = true;
				registered.value = true;
				error.value = null;
			}
		} catch (err) {
			if (signal.aborted || cancelled) {
				return;
			}
			if (isDuplicateName(err) && attempt === 0) {
				await quiesce();
				if (signal.aborted || cancelled) {
					return;
				}
				await register(target, signal, 1);
				return;
			}
			if (!settled) {
				settled = true;
				error.value = (err as Error | DOMException) ?? null;
			}
		}
	}

	onMounted(() => {
		cancelled = false;
		settled = false;
		controller = new AbortController();
		const signal = controller.signal;
		const current: AxToolDefinition = {
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			execute: tool.execute,
			annotations: tool.annotations,
			exposedTo: tool.exposedTo,
		};
		handlerRef.current = tool.execute;
		void register(current, signal, 0);
	});

	watch(
		() => tool.execute,
		(next) => {
			handlerRef.current = next;
		},
	);

	watch(
		() => snapshotIdentity(tool),
		(next, prev) => {
			if (next === prev) {
				return;
			}
			handlerRef.current = tool.execute;
			if (controller === undefined) {
				return;
			}
			controller.abort();
			cancelled = false;
			settled = false;
			registered.value = false;
			controller = new AbortController();
			const signal = controller.signal;
			const current: AxToolDefinition = {
				name: tool.name,
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				execute: tool.execute,
				annotations: tool.annotations,
				exposedTo: tool.exposedTo,
			};
			void register(current, signal, 0);
		},
	);

	onUnmounted(() => {
		cancelled = true;
		controller?.abort();
		registered.value = false;
	});

	return { supported, registered, error };
}
