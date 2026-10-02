// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

/**
 * Cleanup on the launch path, with the browser replaced by a stand-in.
 *
 * A leaked Chromium outlives the command that made it and keeps the process
 * alive with no exit code, so the guarantee is worth asserting directly. The
 * failure that matters is `newContext` rejecting after a successful launch,
 * which no page or option in this product can provoke — so the boundary is
 * substituted here rather than left untested. Everything else in the driver is
 * exercised against a real browser in `browser-audit.test.ts`.
 */

const launched: Array<{ closed: number; newContext: () => Promise<unknown> }> =
	[];

vi.mock("playwright", () => ({
	chromium: {
		launch: async (): Promise<unknown> => {
			const record = {
				closed: 0,
				newContext: async (): Promise<unknown> => {
					throw new TypeError("context refused");
				},
			};
			launched.push(record);
			return {
				newContext: async (): Promise<unknown> => record.newContext(),
				close: async (): Promise<void> => {
					record.closed += 1;
				},
			};
		},
	},
}));

const { launchBrowser, launchDrivenBrowser } = await import("../src/driver.js");

describe("driver launch cleanup", () => {
	it("closes a browser whose context could not be created", async () => {
		await expect(launchBrowser({ headless: true })).rejects.toThrow(
			"context refused",
		);
		expect(launched.at(-1)?.closed).toBe(1);
	});

	it("closes a driven browser whose context could not be created", async () => {
		await expect(launchDrivenBrowser({ headless: true })).rejects.toThrow(
			"context refused",
		);
		expect(launched.at(-1)?.closed).toBe(1);
	});
});