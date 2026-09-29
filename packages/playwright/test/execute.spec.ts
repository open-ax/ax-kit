// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import type { AxPage } from "../src/ax.js";
import { AxParseError } from "../src/execute.js";
import { expect, test } from "../src/fixture.js";

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

type PageSurface = {
	registerTool: (tool: unknown, options?: unknown) => Promise<unknown>;
	getTools: () => Promise<Array<Record<string, unknown>>>;
};

async function registerTool(
	page: AxPage,
	name: string,
	description: string,
	extra?: Record<string, unknown>,
): Promise<void> {
	await page.evaluate(
		(arg: unknown): Promise<void> => {
			const payload = arg as {
				name: string;
				description: string;
				extra: Record<string, unknown>;
			};
			const holder = document as unknown as Record<string, unknown>;
			const surface = holder.modelContext as unknown as {
				registerTool: (tool: unknown) => Promise<unknown>;
			};
			return surface
				.registerTool({
					name: payload.name,
					description: payload.description,
					execute: async () => null,
					...payload.extra,
				})
				.then(() => undefined);
		},
		{ name, description, extra: extra ?? {} },
	);
}

function executeSource(): string {
	return readFileSync(new URL("../src/execute.ts", import.meta.url), "utf8");
}

test.beforeEach(async ({ page }) => {
	await gotoSecure(page);
});

test("lists tools sorted in code-unit order with origins", async ({ page }) => {
	await registerTool(page, "apple_tool", "second");
	await registerTool(page, "Zebra_tool", "first");
	await registerTool(page, "apple2_tool", "third");
	const tools = await page.ax.getAvailableTools();
	expect(tools.map((tool) => tool.name)).toEqual([
		"Zebra_tool",
		"apple2_tool",
		"apple_tool",
	]);
	for (const tool of tools) {
		expect(tool.origin).toBe("http://localhost");
	}
});

test("carries the consequential annotation through listings", async ({
	page,
}) => {
	await registerTool(page, "checkout_tool", "pay", {
		annotations: { consequentialHint: true },
	});
	const tools = await page.ax.getAvailableTools();
	const found = tools.find((tool) => tool.name === "checkout_tool");
	expect(found?.annotations?.consequentialHint).toBe(true);
});

test("round-trips typed arguments and results", async ({ page }) => {
	await page.evaluate((): Promise<void> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as {
			registerTool: (tool: unknown) => Promise<unknown>;
		};
		return surface
			.registerTool({
				name: "echo_tool",
				description: "echo",
				inputSchema: {
					type: "object",
					properties: { q: { type: "string" } },
					required: ["q"],
				},
				execute: async (input: unknown) => input,
			})
			.then(() => undefined);
	});
	const out = await page.ax.executeTool<{ q: string }>("echo_tool", {
		q: "hi",
	});
	expect(out).toEqual({ q: "hi" });
});

test("resolves a fresh handle on every call", async ({ page }) => {
	await page.evaluate((): Promise<void> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as PageSurface;
		const controller = new AbortController();
		(window as unknown as Record<string, unknown>).__axSwapController =
			controller;
		return surface
			.registerTool(
				{
					name: "swap_tool",
					description: "v1",
					execute: async () => "v1",
				},
				{ signal: controller.signal },
			)
			.then(() => undefined);
	});
	expect(await page.ax.executeTool<string>("swap_tool", {})).toBe("v1");
	await page.evaluate((): Promise<void> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as PageSurface;
		const controller = (window as unknown as Record<string, unknown>)
			.__axSwapController as AbortController;
		controller.abort();
		delete (window as unknown as Record<string, unknown>).__axSwapController;
		return surface
			.registerTool({
				name: "swap_tool",
				description: "v2",
				execute: async () => "v2",
			})
			.then(() => undefined);
	});
	expect(await page.ax.executeTool<string>("swap_tool", {})).toBe("v2");
});

test("surfaces duplicate and malformed names unchanged", async ({ page }) => {
	await registerTool(page, "dup_tool", "one");
	const duplicate = await page.evaluate((): Promise<string> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as PageSurface;
		return surface
			.registerTool({
				name: "dup_tool",
				description: "two",
				execute: async () => null,
			})
			.then(
				() => "resolved",
				(error: unknown) =>
					error instanceof DOMException ? error.name : "wrong-type",
			);
	});
	expect(duplicate).toBe("InvalidStateError");
	const malformed = await page.evaluate((): Promise<string> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as PageSurface;
		return surface
			.registerTool({
				name: "bad name!",
				description: "bad",
				execute: async () => null,
			})
			.then(
				() => "resolved",
				(error: unknown) =>
					error instanceof DOMException ? error.name : "wrong-type",
			);
	});
	expect(malformed).toBe("InvalidStateError");
});

test("rejects non-object arguments with the specified family", async ({
	page,
}) => {
	await registerTool(page, "strict_tool", "strict");
	const error = await page.ax.executeTool("strict_tool", "nope").then(
		() => null,
		(reason: unknown) => reason as Error,
	);
	expect(error).not.toBeNull();
	expect(error?.name).toBe("TypeError");
});

test("rejects unknown tools and schema violations", async ({ page }) => {
	const missing = await page.ax.executeTool("no_such_tool", {}).then(
		() => null,
		(reason: unknown) => reason as Error,
	);
	expect(missing).not.toBeNull();
	expect(missing?.message).toContain("no_such_tool");
	await page.evaluate((): Promise<void> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as {
			registerTool: (tool: unknown) => Promise<unknown>;
		};
		return surface
			.registerTool({
				name: "guarded_tool",
				description: "guarded",
				inputSchema: {
					type: "object",
					properties: { q: { type: "string" } },
					required: ["q"],
				},
				execute: async (input: unknown) => input,
			})
			.then(() => undefined);
	});
	await expect(
		page.ax.executeTool("guarded_tool", { q: 42 }),
	).rejects.toThrow();
});

test("keeps execution cancellation distinct from availability", async ({
	page,
}) => {
	await registerTool(page, "steady_tool", "steady");
	const controller = new AbortController();
	const pending = page.ax.executeTool(
		"steady_tool",
		{},
		{
			signal: controller.signal,
		},
	);
	controller.abort();
	await expect(pending).rejects.toThrow();
	const tools = await page.ax.getAvailableTools();
	expect(tools.some((tool) => tool.name === "steady_tool")).toBe(true);
});

test("forwards origin scoping options", async ({ page }) => {
	await registerTool(page, "scoped_tool", "scoped");
	const tools = await page.ax.getAvailableTools({
		fromOrigins: ["http://localhost"],
	});
	expect(tools.some((tool) => tool.name === "scoped_tool")).toBe(true);
});

test("envelopes unparsable results in a typed error", () => {
	const failure = new AxParseError("demo_tool", "not json", new SyntaxError());
	expect(failure.name).toBe("AxParseError");
	expect(failure.toolName).toBe("demo_tool");
	expect(failure.raw).toBe("not json");
	expect(failure.message).toContain("demo_tool");
	expect(failure).toBeInstanceOf(Error);
});

test("resolves names afresh inside the page on every call", () => {
	const source = executeSource();
	expect(source).toContain("getTools");
	expect(source).toContain(".find(");
	expect(source).toContain("JSON.parse");
	expect(source).toContain("AxParseError");
	expect(source).not.toContain("exposeFunction");
});
