// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Runner-side shapes for the typed page surface. These are ours, not the
 * draft's: the draft defines `RegisteredTool` with a live `window` field
 * that cannot cross the evaluate boundary, so the companion strips it and
 * carries names instead. Nothing here is visible to a conformance run.
 */

export interface AxToolAnnotations {
	readonly readOnlyHint?: boolean | undefined;
	readonly untrustedContentHint?: boolean | undefined;
	readonly consequentialHint?: boolean | undefined;
	readonly debugging?: boolean | undefined;
}

export interface AxToolSummary {
	readonly name: string;
	readonly description: string;
	readonly title: string;
	readonly origin: string;
	readonly annotations?: AxToolAnnotations | undefined;
}

export interface AxWaitOptions {
	readonly timeout?: number | undefined;
}

export interface AxExpectOptions {
	readonly timeout?: number | undefined;
}

export interface AxListOptions {
	readonly fromOrigins?: ReadonlyArray<string> | undefined;
}

export interface AxExecuteOptions {
	readonly signal?: AbortSignal | undefined;
}
