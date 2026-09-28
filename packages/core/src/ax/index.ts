// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in conveniences. Everything here is ours, not draft-derived: synchronous
 * removal, single-name lookup, parsed-result invocation, and diff-detail
 * change tracking. Import `@ax-kit/core/ax` to use them; the root entry never
 * exposes them, so no conformant path can observe them.
 */

import { parseOriginList, warnDiagnostic } from "../gates.js";
import {
	checkCallerGates,
	collectRegisteredTools,
	unregisterRecord,
} from "../registry.js";
import type {
	ModelContext,
	ModelContextExecuteToolOptions,
	ModelContextGetToolOptions,
	RegisteredTool,
} from "../types.js";

export interface ToolChangeDiff {
	readonly added: ReadonlyArray<string>;
	readonly removed: ReadonlyArray<string>;
}

function defaultDocument(): Document {
	const candidate = (globalThis as unknown as Record<string, unknown>)[
		"document"
	];
	if (typeof candidate !== "object" || candidate === null) {
		throw new TypeError("no document is available");
	}
	return candidate as Document;
}

/**
 * Remove a tool synchronously. Returns whether a tool was removed. The
 * draft removes via the registration signal; this is the lifecycle-friendly
 * equivalent for component teardown.
 */
export function unregisterTool(name: string, doc?: Document): boolean {
	const target = doc ?? defaultDocument();
	checkCallerGates(target);
	const { removed } = unregisterRecord(target, String(name));
	return removed;
}

/**
 * Look up one tool by name. Async like the listing it narrows: the draft
 * lookup is filter-over-list, and so is this.
 */
export async function getTool(
	name: string,
	doc?: Document,
	options?: ModelContextGetToolOptions,
): Promise<RegisteredTool | undefined> {
	const target = doc ?? defaultDocument();
	checkCallerGates(target);
	const wanted = String(name);
	const rawFrom: unknown = options?.fromOrigins;
	const fromOrigins =
		rawFrom === undefined ? [] : parseOriginList(rawFrom, "fromOrigins");
	return collectRegisteredTools(target, fromOrigins).find(
		(tool) => tool.name === wanted,
	);
}

/**
 * Invoke a tool and return the parsed result value. The draft resolves to a
 * JSON string the caller parses; this parses it. Rejections propagate
 * unchanged.
 */
export async function executeToolResult(
	context: ModelContext,
	tool: RegisteredTool,
	inputObject?: unknown,
	options?: ModelContextExecuteToolOptions,
): Promise<unknown> {
	const result = await context.executeTool(tool, inputObject, options);
	return JSON.parse(result) as unknown;
}

export type ToolChangeListener = (diff: ToolChangeDiff) => void;

/**
 * Track set changes with `{ added, removed }` name diffs. The draft change
 * notification carries no payload; this re-lists on every notification and
 * diffs. Resolves to an unsubscribe function once the baseline snapshot is
 * taken, so the first diff never replays pre-existing tools.
 */
export async function trackToolChanges(
	context: ModelContext,
	listener: ToolChangeListener,
): Promise<() => void> {
	let previous = new Set((await context.getTools()).map((tool) => tool.name));
	const onChange = (): void => {
		void context
			.getTools()
			.then((tools) => {
				const current = new Set(tools.map((tool) => tool.name));
				const added = [...current].filter((name) => !previous.has(name));
				const removed = [...previous].filter((name) => !current.has(name));
				previous = current;
				if (added.length > 0 || removed.length > 0) {
					listener({ added, removed });
				}
			})
			.catch(() => {
				warnDiagnostic("tool listing failed during change tracking");
			});
	};
	context.addEventListener("toolchange", onChange);
	return () => {
		context.removeEventListener("toolchange", onChange);
	};
}
