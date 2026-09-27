// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Table A dictionary shapes, mapped from the pinned draft IDL with the
 * contract corrections applied before code (spec.md D1-D3):
 *
 * - `name`/`description` are `DOMString` on both dictionaries; only the input
 *   `title` member is `USVString`, converted with lone-surrogate replacement.
 * - `execute` is required: registration without a callback is invalid.
 * - Listed `title`/`description` are `DOMString`.
 *
 * Pinned draft: Draft Community Group Report, 26 September 2026.
 */

export interface ToolAnnotations {
	readonly readOnlyHint?: boolean | undefined;
	readonly untrustedContentHint?: boolean | undefined;
	readonly consequentialHint?: boolean | undefined;
	readonly debugging?: boolean | undefined;
}

export interface ToolExecuteCallbackOptions {
	readonly signal: AbortSignal;
}

export type ToolExecuteCallback = (
	inputObject: unknown,
	options: ToolExecuteCallbackOptions,
) => Promise<unknown>;

export interface ModelContextTool {
	readonly name: string;
	readonly title?: string | undefined;
	readonly description: string;
	readonly inputSchema?: unknown;
	readonly execute: ToolExecuteCallback;
	readonly annotations?: ToolAnnotations | undefined;
}

export interface RegisteredTool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema?: unknown;
	readonly window: Window;
	readonly origin: string;
	readonly annotations?: ToolAnnotations | undefined;
}

export interface ModelContextRegisterToolOptions {
	readonly exposedTo?: ReadonlyArray<string> | undefined;
	readonly signal?: AbortSignal | undefined;
}

export interface ModelContextGetToolOptions {
	readonly fromOrigins?: ReadonlyArray<string> | undefined;
}

export interface ModelContextExecuteToolOptions {
	readonly signal?: AbortSignal | undefined;
}

export type ModelEventHandler = ((event: Event) => void) | null;

export interface ModelContext extends EventTarget {
	registerTool(
		tool: ModelContextTool,
		options?: ModelContextRegisterToolOptions | undefined,
	): Promise<undefined>;
	getTools(
		options?: ModelContextGetToolOptions | undefined,
	): Promise<RegisteredTool[]>;
	executeTool(
		tool: RegisteredTool,
		inputObject?: unknown,
		options?: ModelContextExecuteToolOptions | undefined,
	): Promise<string>;
	ontoolchange: ModelEventHandler;
	ontoolactivated: ModelEventHandler;
	ontoolcancel: ModelEventHandler;
}

/**
 * USVString conversion: coerce with `String`, then replace lone surrogates
 * with U+FFFD. Mirrors the WebIDL conversion the platform applies to the
 * input `title` member.
 */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

export function toUSVString(value: unknown): string {
	return String(value).replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		REPLACEMENT_CHARACTER,
	);
}
