// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type {
	PlaywrightTestArgs,
	PlaywrightTestOptions,
	PlaywrightWorkerArgs,
	PlaywrightWorkerOptions,
	TestType,
} from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import type { AxPage } from "./ax.js";
import { AxCompanion } from "./ax.js";
import { resolveInitScriptPath } from "./paths.js";

export type AxTestArgs = PlaywrightTestArgs &
	PlaywrightTestOptions & { page: AxPage };
export type AxWorkerArgs = PlaywrightWorkerArgs & PlaywrightWorkerOptions;

/**
 * Overriding page fixture. It installs exactly one init script carrying the
 * built page-side bundle before any test navigation, attaches the
 * runner-realm companion, yields the page, and disposes the init-script
 * handle on teardown so no registration outlives its test.
 */
export const test: TestType<AxTestArgs, AxWorkerArgs> = base.extend<{
	page: AxPage;
}>({
	page: async ({ page }, use) => {
		const initPath = resolveInitScriptPath();
		const handle = await page.addInitScript({ path: initPath });
		try {
			const axPage = page as AxPage;
			axPage.ax = new AxCompanion(page);
			await use(axPage);
		} finally {
			await handle.dispose();
		}
	},
});

export { expect };
