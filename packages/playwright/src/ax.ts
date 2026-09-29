// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "@playwright/test";

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
}

/** A page with the runner-realm companion attached by the fixture. */
export type AxPage = Page & {
	ax: AxCompanion;
};
