// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import type { AxPage } from "../src/ax.js";
import { expect, test } from "../src/fixture.js";
import { compareToolNames, findToolByName } from "../src/match.js";

async function gotoSecure(page: AxPage): Promise<void> {
	await page.route("http://localhost/**/*", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><html><body></body></html>",
		});
	});
	await page.goto("http://localhost/");
}

async function registerTool(
	page: AxPage,
	name: string,
	description: string,
): Promise<void> {
	await page.evaluate(
		(arg: unknown): Promise<void> => {
			const payload = arg as { name: string; description: string };
			const holder = document as unknown as Record<string, unknown>;
			const surface = holder.modelContext as unknown as {
				registerTool: (tool: unknown) => Promise<unknown>;
			};
			return surface
				.registerTool({
					name: payload.name,
					description: payload.description,
					execute: async () => null,
				})
				.then(() => undefined);
		},
		{ name, description },
	);
}

function waitSource(): string {
	return readFileSync(new URL("../src/wait.ts", import.meta.url), "utf8");
}

test.beforeEach(async ({ page }) => {
	await gotoSecure(page);
});

test("resolves on a pre-flight hit", async ({ page }) => {
	await registerTool(page, "preflight_tool", "already here");
	const found = await page.ax.waitForTool("preflight_tool");
	expect(found.name).toBe("preflight_tool");
	expect(found.description).toBe("already here");
});

test("resolves a late registration via the change hint", async ({ page }) => {
	const pending = page.ax.waitForTool("late_tool");
	await registerTool(page, "late_tool", "arrives late");
	const found = await pending;
	expect(found.name).toBe("late_tool");
});

test("rejects deterministically on timeout", async ({ page }) => {
	const error = await page.ax
		.waitForTool("missing_tool", { timeout: 200 })
		.then(
			() => null,
			(reason: unknown) => reason as Error,
		);
	expect(error).not.toBeNull();
	expect(error?.name).toBe("TimeoutError");
	expect(error?.message).toContain("missing_tool");
});

test("matches by exact name in code-unit order", async ({ page }) => {
	expect(compareToolNames("Zebra", "apple")).toBeLessThan(0);
	await registerTool(page, "Case_Tool", "upper");
	await registerTool(page, "case_tool", "lower");
	const upper = await page.ax.waitForTool("Case_Tool");
	const lower = await page.ax.waitForTool("case_tool");
	expect(upper.description).toBe("upper");
	expect(lower.description).toBe("lower");
	expect(findToolByName([upper, lower], "case_tool")?.description).toBe(
		"lower",
	);
});

test("ignores unrelated registrations", async ({ page }) => {
	const pending = page.ax.waitForTool("wanted_tool", { timeout: 5_000 });
	await registerTool(page, "unrelated_tool", "noise");
	await registerTool(page, "wanted_tool", "signal");
	const found = await pending;
	expect(found.name).toBe("wanted_tool");
	expect(found.description).toBe("signal");
});

test("expectTool agrees with waitForTool", async ({ page }) => {
	await registerTool(page, "shared_tool", "both flavors");
	const viaWait = await page.ax.waitForTool("shared_tool");
	const viaExpect = await page.ax.expectTool("shared_tool");
	expect(viaWait.name).toBe(viaExpect.name);
	expect(viaExpect.description).toBe("both flavors");
	const pending = page.ax.expectTool("late_expect_tool");
	await registerTool(page, "late_expect_tool", "late");
	expect((await pending).name).toBe("late_expect_tool");
});

test("expectTool forwards the timeout", async ({ page }) => {
	const error = await page.ax.expectTool("absent_tool", { timeout: 300 }).then(
		() => null,
		(reason: unknown) => reason as Error,
	);
	expect(error).not.toBeNull();
	expect(error?.name).toBe("TimeoutError");
	expect(error?.message).toContain("absent_tool");
});

test("builds the wait on the change hint with a bounded guard", () => {
	const source = waitSource();
	expect(source).toContain("toolchange");
	expect(source).toContain("setTimeout");
	expect(source).toContain("once: true");
	expect(source).not.toContain("waitForTimeout");
	expect(source).not.toContain("MutationObserver");
	expect(source).not.toContain("waitForEvent");
});
