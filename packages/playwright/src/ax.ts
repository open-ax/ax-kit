// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "@playwright/test";
import type { AxExpectOptions, AxToolSummary, AxWaitOptions } from "./types.js";
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
			return typeof candidate === "object" && candidate !== null;
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
}

/** A page with the runner-realm companion attached by the fixture. */
export type AxPage = Page & {
	ax: AxCompanion;
};
