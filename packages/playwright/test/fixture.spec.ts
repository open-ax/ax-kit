// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { mergeTests } from "@playwright/test";
import type { AxPage } from "../src/ax.js";
import { expect, test } from "../src/fixture.js";

function fixtureSource(): string {
	return readFileSync(new URL("../src/fixture.ts", import.meta.url), "utf8");
}

function axSource(): string {
	return readFileSync(new URL("../src/ax.ts", import.meta.url), "utf8");
}

function countHaystack(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

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

test("installs before the first navigation", async ({ page }) => {
	await gotoSecure(page);
	const installed = await page.ax.isInstalled();
	expect(installed).toBe(true);
	const kind = await page.evaluate((): string => {
		const holder = document as unknown as Record<string, unknown>;
		return typeof holder.modelContext;
	});
	expect(kind).toBe("object");
});

test("attaches the companion in the runner realm", async ({ page }) => {
	expect(page.ax).toBeDefined();
	expect(page.ax.page).toBe(page);
	await gotoSecure(page);
	await expect(page.ax.isInstalled()).resolves.toBe(true);
});

test("installs no page-visible helper", async ({ page }) => {
	await gotoSecure(page);
	const leaked = await page.evaluate((): unknown => {
		const scope = window as unknown as Record<string, unknown>;
		return {
			ax: scope.__ax ?? scope.ax,
			modelContextOnWindow: scope.modelContext,
		};
	});
	expect(leaked).toEqual({ ax: undefined, modelContextOnWindow: undefined });
	expect(await page.ax.isInstalled()).toBe(true);
});

test("uses exactly one init script", () => {
	const source = fixtureSource();
	expect(countHaystack(source, "addInitScript")).toBe(1);
	expect(countHaystack(source, "{ path")).toBe(1);
});

test("rejects plain objects without the typed methods", () => {
	const source = axSource();
	expect(source).toContain("getTools");
	expect(source).toContain("registerTool");
	expect(source).toContain("executeTool");
});

test("disposes the init-script handle on teardown", () => {
	const source = fixtureSource();
	expect(source).toContain(".dispose()");
	expect(source).toContain("try");
	expect(source).toContain("finally");
});

const workerTest = test.extend<object, { greeting: string }>({
	greeting: [
		// biome-ignore lint/correctness/noEmptyPattern: runner requires destructured fixtures
		async ({}, use) => {
			await use("hi");
		},
		{ scope: "worker" },
	],
});

workerTest("composes with worker-scoped setup", async ({ greeting, page }) => {
	expect(greeting).toBe("hi");
	expect(page.ax).toBeDefined();
	await gotoSecure(page);
	expect(await page.ax.isInstalled()).toBe(true);
});

const other = test.extend<{ note: string }>({
	// biome-ignore lint/correctness/noEmptyPattern: runner requires destructured fixtures
	note: async ({}, use) => {
		await use("note");
	},
});

const merged = mergeTests(test, other);

merged("composes across modules", async ({ note, page }) => {
	expect(note).toBe("note");
	expect(page.ax).toBeDefined();
	await gotoSecure(page);
	expect(await page.ax.isInstalled()).toBe(true);
});
