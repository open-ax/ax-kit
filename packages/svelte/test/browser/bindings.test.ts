// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { ModelContext } from "@ax-kit/core";
import { installModelContext } from "@ax-kit/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axTool } from "../../src/index.js";

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

describe("svelte bindings in real chromium", () => {
	it("registers on mount with destroy teardown", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const handle = axTool(el, {
			name: "browser_svelte_mount",
			description: "real mount",
			execute: () => Promise.resolve("ok"),
		});
		await settle();
		expect((await context().getTools()).map((t) => t.name)).toContain(
			"browser_svelte_mount",
		);
		handle.destroy?.();
		await settle();
		expect((await context().getTools()).map((t) => t.name)).not.toContain(
			"browser_svelte_mount",
		);
		el.remove();
	});
});
