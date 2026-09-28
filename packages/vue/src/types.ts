// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Public shapes for `@ax-kit/vue`. Everything here is ours, not
 * draft-derived: the draft defines `document.modelContext`, while the
 * composable and directive are conveniences reachable only through this
 * entry so no spec-conformant core path can observe them.
 */

export interface AxAnnotations {
	readonly readOnlyHint?: boolean | undefined;
	readonly untrustedContentHint?: boolean | undefined;
	readonly consequentialHint?: boolean | undefined;
	readonly debugging?: boolean | undefined;
}

export interface AxExecuteOptions {
	readonly signal: AbortSignal;
}

export type AxExecuteCallback = (
	inputObject: unknown,
	options: AxExecuteOptions,
) => Promise<unknown>;

export interface AxToolDefinition {
	readonly name: string;
	readonly title?: string | undefined;
	readonly description: string;
	readonly inputSchema?: unknown;
	readonly execute: AxExecuteCallback;
	readonly annotations?: AxAnnotations | undefined;
	readonly exposedTo?: ReadonlyArray<string> | undefined;
}

/** Structural view of the core surface. Never a runtime import. */
export interface AxModelContextLike {
	registerTool(
		tool: {
			readonly name: string;
			readonly title?: string | undefined;
			readonly description: string;
			readonly inputSchema?: unknown;
			readonly execute: AxExecuteCallback;
			readonly annotations?: AxAnnotations | undefined;
		},
		options?:
			| {
					readonly exposedTo?: ReadonlyArray<string> | undefined;
					readonly signal?: AbortSignal | undefined;
			  }
			| undefined,
	): Promise<undefined>;
}
