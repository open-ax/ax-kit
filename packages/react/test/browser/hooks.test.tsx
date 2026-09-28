// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { ModelContext } from "@ax-kit/core";
import { installModelContext } from "@ax-kit/core";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAxTool } from "../../src/index.js";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
	true;

function context(): ModelContext {
	const raw = document as unknown as Record<string, unknown>;
	const mc = raw.modelContext as ModelContext | undefined;
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

let roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
	document.body.innerHTML = "";
	installModelContext(document);
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots = [];
	const { unregisterTool } = await import("@ax-kit/core/ax");
	for (const tool of await context().getTools()) {
		unregisterTool(tool.name);
	}
	await settle();
	document.body.innerHTML = "";
});

describe("react bindings in real chromium", () => {
	it("registers under a real root and cleans up", async () => {
		function Tool(): React.ReactNode {
			useAxTool({
				name: "browser_mount",
				description: "real root",
				execute: async () => "ok",
			});
			return null;
		}
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		roots.push(root);
		await act(async () => {
			root.render(<Tool />);
		});
		await act(async () => {
			await settle();
		});
		const names = (await context().getTools()).map((t) => t.name);
		expect(names).toContain("browser_mount");
	});

	it("leaves exactly one registration under StrictMode double-mount", async () => {
		function Tool(): React.ReactNode {
			useAxTool({
				name: "browser_strict",
				description: "strict gate",
				execute: async () => "ok",
			});
			return null;
		}
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		roots.push(root);
		await act(async () => {
			root.render(
				<StrictMode>
					<Tool />
				</StrictMode>,
			);
		});
		await act(async () => {
			await settle();
		});
		await act(async () => {
			await settle();
		});
		const names = (await context().getTools())
			.map((t) => t.name)
			.filter((n) => n === "browser_strict");
		expect(names).toEqual(["browser_strict"]);
	});
});
