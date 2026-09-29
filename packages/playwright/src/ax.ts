// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "@playwright/test";
import { executeTool, getAvailableTools } from "./execute.js";
import type {
	AxExecuteOptions,
	AxExpectOptions,
	AxListOptions,
	AxToolSummary,
	AxWaitOptions,
} from "./types.js";
import { expectTool, waitForTool } from "./wait.js";

/**
 * Runner-realm companion attached to the page by the fixture. It never
 * enters the page namespace: all state lives in the test process and only
 * serializable data crosses the evaluate boundary.
 */
export class AxCompanion {
	readonly page: Page;

	constructor(page: Page) {
		this.page = page;
	}

	/**
	 * True where the page-side bundle installed the typed surface.
	 * Feature-detects rather than assuming installation succeeded.
	 */
	async isInstalled(): Promise<boolean> {
		return this.page.evaluate((): boolean => {
			const holder = document as unknown as Record<string, unknown>;
			const candidate = holder.modelContext;
			if (typeof candidate !== "object" || candidate === null) {
				return false;
			}
			const surface = candidate as Record<string, unknown>;
			return (
				typeof surface.getTools === "function" &&
				typeof surface.registerTool === "function" &&
				typeof surface.executeTool === "function"
			);
		});
	}

	/**
	 * Resolve when the named tool is listed, via pre-flight plus an
	 * in-page change hint with a bounded guard. Matches by name in
	 * code-unit order; spurious wakes re-list until the deadline.
	 */
	async waitForTool(
		name: string,
		options?: AxWaitOptions,
	): Promise<AxToolSummary> {
		return waitForTool(this.page, name, options);
	}

	/**
	 * Assertion flavor over the same listing and matcher, polling with
	 * the runner's retrying primitive and forwarded timeout options.
	 */
	async expectTool(
		name: string,
		options?: AxExpectOptions,
	): Promise<AxToolSummary> {
		return expectTool(this.page, name, options);
	}

	/**
	 * Available tools sorted ascending by name in code-unit order, with
	 * origin scoping preserved from the underlying surface.
	 */
	async getAvailableTools(options?: AxListOptions): Promise<AxToolSummary[]> {
		return getAvailableTools(this.page, options);
	}

	/**
	 * Execute a named tool with serializable arguments. The name resolves
	 * to a fresh handle inside the page on every call; the string result
	 * parses at this boundary with a typed error on failure.
	 */
	async executeTool<T = unknown>(
		name: string,
		args?: unknown,
		options?: AxExecuteOptions,
	): Promise<T> {
		return executeTool<T>(this.page, name, args, options);
	}
}

/** A page with the runner-realm companion attached by the fixture. */
export type AxPage = Page & {
	ax: AxCompanion;
};
