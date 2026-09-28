// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { ModelContext } from "@ax-kit/core";
import { installModelContext } from "@ax-kit/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axTool, axToolEffect, isAxSupported } from "../src/index.js";

function context(): ModelContext {
	const raw = document as unknown as { modelContext?: ModelContext };
	const mc = raw.modelContext;
	if (mc === undefined) {
		throw new Error("modelContext not installed");
	}
	return mc;
}

function nextTask(): Promise<void> {
	return new Promise<void>((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = (): void => {
			channel.port1.close();
			channel.port2.close();
			resolve();
		};
		channel.port2.postMessage(undefined);
	});
}

async function settle(): Promise<void> {
	await nextTask();
	await nextTask();
}

async function listedNames(): Promise<string[]> {
	return (await context().getTools()).map((t) => t.name);
}

beforeEach(() => {
	document.body.innerHTML = "";
	installModelContext(document);
});

afterEach(async () => {
	const { unregisterTool } = await import("@ax-kit/core/ax");
	for (const tool of await context().getTools()) {
		unregisterTool(tool.name);
	}
	await settle();
	document.body.innerHTML = "";
});

describe("axTool element binding", () => {
	it("registers on mount with abort on destroy", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const handle = axTool(el, {
			name: "svelte_mount",
			description: "mount lifecycle",
			execute: () => Promise.resolve("ok"),
		});
		await settle();
		expect(await listedNames()).toContain("svelte_mount");
		handle.destroy?.();
		await settle();
		expect(await listedNames()).not.toContain("svelte_mount");
		el.remove();
	});

	it("swaps on parameter update and never orphans names", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const handle = axTool(el, {
			name: "svelte_swap",
			description: "one",
			execute: () => Promise.resolve("ok"),
		});
		await settle();
		handle.update?.({
			name: "svelte_swap",
			description: "two",
			execute: () => Promise.resolve("ok"),
		});
		await settle();
		await settle();
		const entry = (await context().getTools()).find(
			(t) => t.name === "svelte_swap",
		);
		expect(entry?.description).toBe("two");
		handle.destroy?.();
		el.remove();
	});

	it("forwards execution to the latest handler", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		let value = "first";
		const handle = axTool(el, {
			name: "svelte_fresh",
			description: "freshness",
			execute: () => Promise.resolve(value),
		});
		await settle();
		value = "second";
		handle.update?.({
			name: "svelte_fresh",
			description: "freshness",
			execute: () => Promise.resolve(value),
		});
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "svelte_fresh",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		expect(JSON.parse(await context().executeTool(tool, {}))).toBe("second");
		handle.destroy?.();
		el.remove();
	});

	it("keeps registration and execution lifetimes distinct", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const handle = axTool(el, {
			name: "svelte_signals",
			description: "signals",
			execute: (_args, { signal }) =>
				new Promise<unknown>((_resolve, reject) => {
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		});
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "svelte_signals",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		const controller = new AbortController();
		const pending = context().executeTool(
			tool,
			{},
			{ signal: controller.signal },
		);
		controller.abort(new DOMException("stop", "AbortError"));
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(await listedNames()).toContain("svelte_signals");
		handle.destroy?.();
		el.remove();
	});

	it("preserves consequential annotation and sorted matching", async () => {
		const first = document.createElement("div");
		const second = document.createElement("div");
		document.body.append(first, second);
		const a = axTool(first, {
			name: "sorder_b",
			description: "b",
			annotations: { consequentialHint: true },
			execute: () => Promise.resolve(1),
		});
		const b = axTool(second, {
			name: "sorder_A",
			description: "a",
			execute: () => Promise.resolve(1),
		});
		await settle();
		const names = (await listedNames()).filter((n) => n.startsWith("sorder_"));
		expect(names).toEqual(["sorder_A", "sorder_b"]);
		const scoped = (await context().getTools()).find(
			(t) => t.name === "sorder_b",
		);
		expect(scoped?.annotations?.consequentialHint).toBe(true);
		a.destroy?.();
		b.destroy?.();
		first.remove();
		second.remove();
	});
});

describe("axToolEffect rune helper", () => {
	it("registers and returns teardown for the enclosing effect", async () => {
		const teardown = axToolEffect({
			name: "svelte_rune",
			description: "rune lifecycle",
			execute: () => Promise.resolve("ok"),
		});
		await settle();
		expect(await listedNames()).toContain("svelte_rune");
		teardown();
		await settle();
		expect(await listedNames()).not.toContain("svelte_rune");
	});

	it("holds structural server safety with an explicit guard", async () => {
		const detached = document.implementation.createHTMLDocument("detached");
		expect(isAxSupported(detached)).toBe(false);
		expect(isAxSupported(undefined)).toBe(false);
		expect(isAxSupported(document)).toBe(true);
	});
});
