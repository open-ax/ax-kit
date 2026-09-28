// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { DirectiveBinding, ObjectDirective } from "vue";
import { snapshotIdentity } from "./composable.js";
import type { AxModelContextLike, AxToolDefinition } from "./types.js";

const controllers = new WeakMap<Element, AbortController>();

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
	const execute = tool.execute;
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
			await Promise.resolve();
			await nextTask();
			if (signal.aborted) {
				return;
			}
			await registerElement(el, tool, signal, 1);
			return;
		}
		console.warn(`[ax-kit/vue] tool registration failed: ${String(error)}`);
	}
}

/**
 * Template-authored tools for plain elements only. Registers on mount,
 * aborts on unmount, aborts then registers on value update. Binding
 * arguments are never mutated; per-element state travels in element-attached
 * storage. Component-level tools use the composable instead: directives on
 * components apply root-node only and are ignored with a warning on
 * multi-root components.
 */
export const vAxTool: ObjectDirective<Element, AxToolDefinition> = {
	mounted(el, binding: DirectiveBinding<AxToolDefinition>): void {
		const tool = readTool(binding.value);
		if (tool === undefined) {
			return;
		}
		const controller = new AbortController();
		controllers.set(el, controller);
		void registerElement(el, tool, controller.signal, 0);
	},
	updated(el, binding: DirectiveBinding<AxToolDefinition>): void {
		const next = readTool(binding.value);
		const prev = readTool(binding.oldValue);
		if (next === undefined) {
			controllers.get(el)?.abort();
			controllers.delete(el);
			return;
		}
		if (
			prev !== undefined &&
			snapshotIdentity(next) === snapshotIdentity(prev)
		) {
			return;
		}
		controllers.get(el)?.abort();
		const controller = new AbortController();
		controllers.set(el, controller);
		void registerElement(el, next, controller.signal, 0);
	},
	unmounted(el): void {
		controllers.get(el)?.abort();
		controllers.delete(el);
	},
	getSSRProps(
		_binding: DirectiveBinding<AxToolDefinition>,
	): Record<string, unknown> {
		void _binding;
		return {};
	},
};
