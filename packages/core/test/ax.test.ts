// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import "../src/index.js";
import type { ToolChangeDiff } from "../src/ax/index.js";
import {
	executeToolResult,
	getTool,
	trackToolChanges,
	unregisterTool,
} from "../src/ax/index.js";
import type { ModelContext } from "../src/index.js";
import * as root from "../src/index.js";

function context(): ModelContext {
	const installed = (document as unknown as Record<string, unknown>)[
		"modelContext"
	] as ModelContext | undefined;
	if (installed === undefined) {
		throw new Error("document.modelContext is not installed");
	}
	return installed;
}

describe("ax entry isolation", () => {
	it("exposes no extension on the root entry or the live surface", () => {
		for (const name of [
			"unregisterTool",
			"getTool",
			"executeToolResult",
			"trackToolChanges",
		]) {
			expect(root as unknown as Record<string, unknown>).not.toHaveProperty(
				name,
			);
			expect(
				context() as unknown as Record<string, unknown>,
			).not.toHaveProperty(name);
		}
	});
});

describe("unregisterTool", () => {
	it("removes synchronously and reports whether it removed", async () => {
		const mc = context();
		await mc.registerTool({
			name: "ax_remove",
			description: "remove",
			execute: async () => null,
		});
		let changes = 0;
		mc.addEventListener("toolchange", () => {
			changes += 1;
		});
		expect(unregisterTool("ax_remove")).toBe(true);
		expect(unregisterTool("ax_remove")).toBe(false);
		expect(
			(await mc.getTools()).some((item) => item.name === "ax_remove"),
		).toBe(false);
		expect(changes).toBe(1);
	});
});

describe("getTool", () => {
	it("finds one tool by name", async () => {
		const mc = context();
		await mc.registerTool({
			name: "ax_lookup",
			description: "lookup",
			execute: async () => null,
		});
		expect((await getTool("ax_lookup"))?.description).toBe("lookup");
		expect(await getTool("ax_missing")).toBeUndefined();
	});
});

describe("executeToolResult", () => {
	it("returns the parsed value", async () => {
		const mc = context();
		await mc.registerTool({
			name: "ax_parsed",
			description: "parsed",
			execute: async (inputObject) => ({ echoed: inputObject }),
		});
		const tool = (await mc.getTools()).find(
			(item) => item.name === "ax_parsed",
		);
		if (tool === undefined) {
			throw new Error("tool is not listed");
		}
		expect(await executeToolResult(mc, tool, { q: 1 })).toEqual({
			echoed: { q: 1 },
		});
	});
});

describe("trackToolChanges", () => {
	it("reports added and removed names", async () => {
		const mc = context();
		const diffs: ToolChangeDiff[] = [];
		const stop = await trackToolChanges(mc, (diff) => {
			diffs.push(diff);
		});
		try {
			await mc.registerTool({
				name: "ax_tracked",
				description: "tracked",
				execute: async () => null,
			});
			expect(diffs).toEqual([{ added: ["ax_tracked"], removed: [] }]);
			expect(unregisterTool("ax_tracked")).toBe(true);
			// Let the queued refresh finish ahead of this continuation.
			await mc.getTools();
			expect(diffs).toEqual([
				{ added: ["ax_tracked"], removed: [] },
				{ added: [], removed: ["ax_tracked"] },
			]);
		} finally {
			stop();
		}
	});
});
