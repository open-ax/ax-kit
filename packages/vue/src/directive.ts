// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { DirectiveBinding, ObjectDirective } from "vue";
import { snapshotIdentity } from "./composable.js";
import type {
	AxExecuteCallback,
	AxModelContextLike,
	AxToolDefinition,
} from "./types.js";

interface ElementRegistration {
	controller: AbortController;
	identity: string;
	latest: AxExecuteCallback;
}

const registrations = new WeakMap<Element, ElementRegistration>();

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

function readTool(value: unknown): AxToolDefinition | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.name !== "string" ||
		typeof candidate.description !== "string" ||
		typeof candidate.execute !== "function"
	) {
		console.warn("[ax-kit/vue] tool binding value has an invalid shape");
		return undefined;
	}
	return value as AxToolDefinition;
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

function isDuplicateName(error: unknown): boolean {
	return error instanceof DOMException && error.name === "InvalidStateError";
}

async function registerElement(
	el: Element,
	tool: AxToolDefinition,
	getExecute: () => AxExecuteCallback,
	signal: AbortSignal,
	attempt: number,
): Promise<void> {
	if (!hasWindow()) {
		return;
	}
	const surface = surfaceOf(el.ownerDocument);
	if (surface === undefined) {
		return;
	}
	const stableExecute: AxExecuteCallback = (args, opts) =>
		getExecute()(args, opts);
	try {
		await surface.registerTool(
			{
				name: tool.name,
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				execute: stableExecute,
				annotations: tool.annotations,
			},
			{ exposedTo: tool.exposedTo, signal },
		);
	} catch (error) {
		if (signal.aborted) {
			return;
		}
		if (isDuplicateName(error) && attempt === 0) {
			await Promise.resolve();
			await nextTask();
			if (signal.aborted) {
				return;
			}
			await registerElement(el, tool, getExecute, signal, 1);
			return;
		}
		console.warn(`[ax-kit/vue] tool registration failed: ${String(error)}`);
	}
}

/**
 * Template-authored tools for plain elements only. Registers on mount,
 * aborts on unmount, aborts then registers on identity update while
 * handler-only updates forward through the latest-handler mailbox without
 * re-registration churn. Binding arguments are never mutated; per-element
 * state travels in element-attached storage. Component-level tools use the
 * composable instead: directives on components apply root-node only and are
 * ignored with a warning on multi-root components.
 */
export const vAxTool: ObjectDirective<Element, AxToolDefinition> = {
	mounted(el, binding: DirectiveBinding<AxToolDefinition>): void {
		const tool = readTool(binding.value);
		if (tool === undefined) {
			return;
		}
		const entry: ElementRegistration = {
			controller: new AbortController(),
			identity: snapshotIdentity(tool),
			latest: tool.execute,
		};
		registrations.set(el, entry);
		void registerElement(
			el,
			tool,
			() => entry.latest,
			entry.controller.signal,
			0,
		);
	},
	updated(el, binding: DirectiveBinding<AxToolDefinition>): void {
		const next = readTool(binding.value);
		const entry = registrations.get(el);
		if (next === undefined) {
			entry?.controller.abort();
			registrations.delete(el);
			return;
		}
		if (entry === undefined) {
			const fresh: ElementRegistration = {
				controller: new AbortController(),
				identity: snapshotIdentity(next),
				latest: next.execute,
			};
			registrations.set(el, fresh);
			void registerElement(
				el,
				next,
				() => fresh.latest,
				fresh.controller.signal,
				0,
			);
			return;
		}
		entry.latest = next.execute;
		const identity = snapshotIdentity(next);
		if (identity === entry.identity) {
			return;
		}
		entry.controller.abort();
		entry.controller = new AbortController();
		entry.identity = identity;
		void registerElement(
			el,
			next,
			() => entry.latest,
			entry.controller.signal,
			0,
		);
	},
	unmounted(el): void {
		registrations.get(el)?.controller.abort();
		registrations.delete(el);
	},
	getSSRProps(
		_binding: DirectiveBinding<AxToolDefinition>,
	): Record<string, unknown> {
		void _binding;
		return {};
	},
};
