// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the driver does with a browser it has launched.
 *
 * A leaked Chromium outlives the command that made it and keeps the process
 * alive with no exit code, so both halves of that guarantee are asserted here:
 * the window before a session exists, and the session that does. Neither can be
 * provoked from the product's own inputs — a failed context creation is not
 * reachable through a URL or a launch option — so the browser is substituted.
 * Everything else in this driver is exercised against a real browser in
 * `browser-audit.test.ts`.
 */

interface FakeBrowser {
	readonly contextsClosed: number;
	readonly browsersClosed: number;
}

/** Fails the next `newContext` call, standing in for a context that cannot open. */
let failContext = false;

const launched: FakeBrowser[] = [];

vi.mock("playwright", () => ({
	chromium: {
		launch: async (): Promise<unknown> => {
			const record = { contextsClosed: 0, browsersClosed: 0 };
			launched.push(record);
			return {
				newContext: async (): Promise<unknown> => {
					if (failContext) {
						throw new TypeError("context refused");
					}
					return {
						newPage: async (): Promise<unknown> => ({}),
						close: async (): Promise<void> => {
							record.contextsClosed += 1;
						},
					};
				},
				close: async (): Promise<void> => {
					record.browsersClosed += 1;
				},
			};
		},
	},
}));

const { launchBrowser, launchDrivenBrowser } = await import("../src/driver.js");

beforeEach(() => {
	failContext = false;
	launched.length = 0;
});

describe("driver browser cleanup", () => {
	it("closes a browser whose context could not be created", async () => {
		failContext = true;
		await expect(launchBrowser({ headless: true })).rejects.toThrow(
			"context refused",
		);
		await expect(launchDrivenBrowser({ headless: true })).rejects.toThrow(
			"context refused",
		);
		// Both entry points launch before they have a session, so neither has a
		// caller-side `finally` that could close what it leaked.
		expect(launched.map((entry) => entry.browsersClosed)).toEqual([1, 1]);
	});

	it("closes the browser, not only the context, when a session closes", async () => {
		const session = await launchDrivenBrowser({ headless: true });
		await session.close();
		// Closing only the context leaves the browser process running and the
		// node event loop alive, so the command would never return an exit code.
		expect(launched.at(-1)?.contextsClosed).toBe(1);
		expect(launched.at(-1)?.browsersClosed).toBe(1);
	});
});
