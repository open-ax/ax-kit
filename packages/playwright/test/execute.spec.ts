// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import type { AxPage } from "../src/ax.js";
import { AxMissingSurfaceError } from "../src/errors.js";
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
	expect(error?.message).toBe("bad arguments");
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
	await expect(page.ax.executeTool("guarded_tool", { q: 42 })).rejects.toThrow(
		"tool did not complete",
	);
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

test("fails with the typed error where the surface is absent", async ({
	page,
}) => {
	await page.goto("about:blank");
	const missing = new AxMissingSurfaceError();
	expect(missing.name).toBe("AxMissingSurfaceError");
	expect(missing).toBeInstanceOf(Error);
	const fromList = await page.ax.getAvailableTools().then(
		() => null,
		(reason: unknown) => reason as Error,
	);
	expect(fromList?.name).toBe("AxMissingSurfaceError");
	const fromWait = await page.ax
		.waitForTool("absent_tool", { timeout: 200 })
		.then(
			() => null,
			(reason: unknown) => reason as Error,
		);
	expect(fromWait?.name).toBe("AxMissingSurfaceError");
	const fromExecute = await page.ax.executeTool("absent_tool", {}).then(
		() => null,
		(reason: unknown) => reason as Error,
	);
	expect(fromExecute?.name).toBe("AxMissingSurfaceError");
});

test("matches by name, never by position", async ({ page }) => {
	await page.evaluate((): Promise<void> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as PageSurface;
		const controller = new AbortController();
		(window as unknown as Record<string, unknown>).__axShiftController =
			controller;
		return surface
			.registerTool(
				{
					name: "first_tool",
					description: "first",
					execute: async () => "first-result",
				},
				{ signal: controller.signal },
			)
			.then(() =>
				surface.registerTool({
					name: "second_tool",
					description: "second",
					execute: async () => "second-result",
				}),
			)
			.then(() => undefined);
	});
	expect((await page.ax.getAvailableTools()).map((tool) => tool.name)).toEqual([
		"first_tool",
		"second_tool",
	]);
	await page.evaluate((): void => {
		const controller = (window as unknown as Record<string, unknown>)
			.__axShiftController as AbortController;
		controller.abort();
		delete (window as unknown as Record<string, unknown>).__axShiftController;
	});
	expect(await page.ax.executeTool<string>("second_tool", {})).toBe(
		"second-result",
	);
	expect((await page.ax.getAvailableTools()).map((tool) => tool.name)).toEqual([
		"second_tool",
	]);
});

test("surfaces a denied feature with its specified name", async ({ page }) => {
	const family = await page.evaluate((): Promise<string> => {
		Object.defineProperty(document, "permissionsPolicy", {
			value: {
				allowsFeature: () => false,
				features: () => ["tools"],
			},
			configurable: true,
		});
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as PageSurface;
		return surface.getTools().then(
			() => "resolved",
			(error: unknown) =>
				error instanceof DOMException ? error.name : "wrong-type",
		);
	});
	expect(family).toBe("NotAllowedError");
	const propagated = await page.ax.getAvailableTools().then(
		() => null,
		(reason: unknown) => reason as Error,
	);
	expect(propagated?.message).toContain("tools not allowed");
});

test("rejects untrustworthy origin entries with its specified name", async ({
	page,
}) => {
	const family = await page.evaluate((): Promise<string> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as PageSurface;
		return surface
			.registerTool(
				{
					name: "exposed_tool",
					description: "exposed",
					execute: async () => null,
				},
				{ exposedTo: ["http://evil.example/"] },
			)
			.then(
				() => "resolved",
				(error: unknown) =>
					error instanceof DOMException ? error.name : "wrong-type",
			);
	});
	expect(family).toBe("SecurityError");
});

test("rejects opaque tool origins with its specified name", async ({
	page,
}) => {
	await registerTool(page, "plain_tool", "plain");
	const family = await page.evaluate((): Promise<string> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as {
			getTools: () => Promise<Array<Record<string, unknown>>>;
			executeTool: (tool: unknown, input: unknown) => Promise<string>;
		};
		return surface
			.getTools()
			.then((tools) => {
				const tampered = { ...tools[0], origin: "null" };
				return surface.executeTool(tampered, {});
			})
			.then(
				() => "resolved",
				(error: unknown) =>
					error instanceof DOMException ? error.name : "wrong-type",
			);
	});
	expect(family).toBe("NotSupportedError");
});

test("settles waits when the document unloads", async ({ page }) => {
	const settled = page.ax.waitForTool("never_tool", { timeout: 30_000 }).then(
		() => null,
		(reason: unknown) => reason as Error,
	);
	await page.goto("http://localhost/next.html");
	const error = await settled;
	expect(error).not.toBeNull();
	expect(error?.name).not.toBe("TimeoutError");
});

test("keeps cross-origin frame tools out of main listings", async ({
	page,
}) => {
	await page.route("http://127.0.0.1/**/*", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><html><body>child</body></html>",
		});
	});
	await page.route("http://localhost/**/*", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: '<!doctype html><html><body><iframe src="http://127.0.0.1/child.html"></iframe></body></html>',
		});
	});
	await page.goto("http://localhost/");
	await expect.poll(() => page.frames().length, { timeout: 5_000 }).toBe(2);
	const child = page
		.frames()
		.find((frame) => frame.url().includes("127.0.0.1"));
	expect(child).toBeDefined();
	await child?.evaluate((): Promise<void> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as {
			registerTool: (tool: unknown) => Promise<unknown>;
		};
		return surface
			.registerTool({
				name: "frame_tool",
				description: "frame",
				execute: async () => "frame-result",
			})
			.then(() => undefined);
	});
	const origins = { fromOrigins: ["http://127.0.0.1"] };
	expect(
		(await page.ax.getAvailableTools(origins)).some(
			(tool) => tool.name === "frame_tool",
		),
	).toBe(false);
	// Each frame evaluates its own bundle copy with its own registry, so a
	// cross-origin tool stays frame-local: the frame lists it, the top
	// document never does, and nothing leaks across the boundary.
	const framed = await child?.evaluate((): Promise<ReadonlyArray<string>> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as {
			getTools: () => Promise<Array<Record<string, unknown>>>;
		};
		return surface
			.getTools()
			.then((tools) => tools.map((tool) => String(tool.name)).sort());
	});
	expect(framed).toEqual(["frame_tool"]);
	expect(
		(await page.ax.getAvailableTools()).some(
			(tool) => tool.name === "frame_tool",
		),
	).toBe(false);
});
