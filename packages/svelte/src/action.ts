// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { ActionReturn } from "svelte/action";
import type {
	AxExecuteCallback,
	AxModelContextLike,
	AxToolDefinition,
} from "./types.js";

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

function snapshotIdentity(tool: AxToolDefinition): string {
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

interface Registration {
	readonly controller: AbortController;
	readonly done: Promise<void>;
}

async function startRegistration(
	tool: AxToolDefinition,
	execute: AxExecuteCallback,
	signal: AbortSignal,
	attempt: number,
): Promise<void> {
	if (!hasWindow()) {
		return;
	}
	const surface = surfaceOf(document);
	if (surface === undefined) {
		return;
	}
	try {
		await surface.registerTool(
			{
				name: tool.name,
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				execute,
				annotations: tool.annotations,
			},
			{ exposedTo: tool.exposedTo, signal },
		);
	} catch (error) {
		if (signal.aborted) {
			return;
		}
		if (isDuplicateName(error) && attempt === 0) {
			await quiesce();
			if (signal.aborted) {
				return;
			}
			await startRegistration(tool, execute, signal, 1);
			return;
		}
		console.warn(`[ax-kit/svelte] tool registration failed: ${String(error)}`);
	}
}

function begin(
	tool: AxToolDefinition,
	execute: AxExecuteCallback,
): Registration {
	const controller = new AbortController();
	const done = startRegistration(tool, execute, controller.signal, 0);
	return { controller, done };
}

/**
 * Element binding for `use:axTool`. One teardown mechanism: the
 * parameter-update plus destroy callbacks. Update aborts then registers
 * while destroy aborts, so reactive re-runs never orphan names. Actions do
 * not run during server rendering; shared helper paths keep an explicit
 * window guard for universal-module imports.
 *
 * Attachments evaluated at build time against Svelte 5.57: the action
 * contract remains supported and typed, and callers preferring attachments
 * can wrap it with `fromAction(axTool, () => params)` without a migration.
 */
export function axTool(
	_node: Element,
	params: AxToolDefinition,
): ActionReturn<AxToolDefinition> {
	let current = params;
	let latest: AxExecuteCallback = params.execute;
	let registration = begin(current, (args, opts) => latest(args, opts));
	return {
		update(next: AxToolDefinition): void {
			const prev = current;
			current = next;
			latest = next.execute;
			if (snapshotIdentity(next) === snapshotIdentity(prev)) {
				return;
			}
			registration.controller.abort();
			registration = begin(current, (args, opts) => latest(args, opts));
		},
		destroy(): void {
			registration.controller.abort();
		},
	};
}

/**
 * Rune helper. Call inside `$effect` with synchronously-read reactive
 * values and return the teardown, so re-runs abort before re-registering
 * and destroy aborts. Never writes component state; freshness follows the
 * framework's own tracking.
 *
 * ```svelte
 * <script>
 *   import { axToolEffect } from "@ax-kit/svelte";
 *   let desc = $state("one");
 *   $effect(() => axToolEffect({ name: "tool", description: desc, execute }));
 * </script>
 * ```
 */
export function axToolEffect(tool: AxToolDefinition): () => void {
	if (!hasWindow()) {
		return () => {};
	}
	const surface = surfaceOf(document);
	if (surface === undefined) {
		return () => {};
	}
	// Read reactive values synchronously so the enclosing effect tracks
	// them; post-await reads are not tracked.
	const snapshot: AxToolDefinition = {
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		execute: tool.execute,
		annotations: tool.annotations,
		exposedTo: tool.exposedTo,
	};
	const registration = begin(snapshot, snapshot.execute);
	return () => {
		registration.controller.abort();
	};
}
