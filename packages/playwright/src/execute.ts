// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "@playwright/test";
import { withSurfaceError } from "./errors.js";
import { listToolSummaries } from "./listing.js";
import type {
	AxExecuteOptions,
	AxListOptions,
	AxToolSummary,
} from "./types.js";

/**
 * Structured parse failure: the tool resolved to a string outside JSON,
 * so call sites receive a typed error carrying the tool name and the raw
 * text instead of a bare syntax error.
 */
export class AxParseError extends Error {
	readonly toolName: string;
	readonly raw: string;

	constructor(toolName: string, raw: string, cause: unknown) {
		super(`unparsable result from tool "${toolName}"`);
		this.name = "AxParseError";
		this.toolName = toolName;
		this.raw = raw;
		this.cause = cause;
	}
}

function raceWithSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted === true) {
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		function onAbort(): void {
			reject(signal.reason);
		}
		signal.addEventListener("abort", onAbort, { once: true });
		task.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Available tools sorted ascending by name in code-unit order, with origin
 * scoping preserved from the underlying surface.
 */
export async function getAvailableTools(
	page: Page,
	options?: AxListOptions,
): Promise<AxToolSummary[]> {
	const fromOrigins = options?.fromOrigins;
	if (fromOrigins !== undefined) {
		if (!Array.isArray(fromOrigins)) {
			throw new TypeError("bad fromOrigins");
		}
		for (const origin of fromOrigins) {
			if (typeof origin !== "string") {
				throw new TypeError("bad fromOrigins");
			}
		}
	}
	return listToolSummaries(page, fromOrigins);
}

/**
 * Execute a named tool with serializable arguments. The name is resolved
 * to a fresh handle inside the page on every call and never cached across
 * the boundary; the specified string result is parsed at this boundary.
 * Draft rejection families propagate unchanged.
 */
export async function executeTool<T = unknown>(
	page: Page,
	name: string,
	args?: unknown,
	options?: AxExecuteOptions,
): Promise<T> {
	if (typeof name !== "string") {
		throw new TypeError("bad tool name");
	}
	const input: unknown = args === undefined ? {} : args;
	if (typeof input !== "object" || input === null) {
		throw new TypeError("bad arguments");
	}
	const signal = options?.signal;
	if (signal !== undefined) {
		if (
			typeof signal.aborted !== "boolean" ||
			typeof signal.addEventListener !== "function"
		) {
			throw new TypeError("bad signal");
		}
	}
	const task: Promise<string> = page.evaluate(
		(arg: unknown): Promise<string> => {
			const payload = arg as { name: unknown; input: unknown };
			const wanted = typeof payload.name === "string" ? payload.name : "";
			const holder = document as unknown as Record<string, unknown>;
			const raw = holder.modelContext as unknown;
			if (typeof raw !== "object" || raw === null) {
				throw new Error("typed surface is missing");
			}
			const surface = raw as {
				getTools: () => Promise<Array<Record<string, unknown>>>;
				executeTool: (tool: unknown, input: unknown) => Promise<string>;
			};
			if (
				typeof surface.getTools !== "function" ||
				typeof surface.executeTool !== "function"
			) {
				throw new Error("typed surface is missing");
			}
			return surface
				.getTools()
				.then((tools) => {
					const match = tools.find(
						(tool) => typeof tool.name === "string" && tool.name === wanted,
					);
					if (match === undefined) {
						throw new DOMException(`unknown tool ${wanted}`, "UnknownError");
					}
					return surface.executeTool(match, payload.input);
				})
				.then((text) => {
					if (typeof text !== "string") {
						throw new DOMException("bad tool result", "UnknownError");
					}
					return text;
				});
		},
		{ name, input },
	);
	const text =
		signal === undefined
			? await withSurfaceError(task)
			: await raceWithSignal(withSurfaceError(task), signal);
	try {
		return JSON.parse(text) as T;
	} catch (cause: unknown) {
		throw new AxParseError(name, text, cause);
	}
}
