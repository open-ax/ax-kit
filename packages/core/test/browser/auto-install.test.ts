// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

// The auto-installing entry point against a real browser's document.
//
// The fast layer covers the no-document case by removing the ambient global.
// What only a real browser can show is that the entry point's own import-time
// call installs something usable: the import must survive module evaluation,
// the surface must be a real EventTarget, and a tool registered through it must
// be enumerable and invokable by an agent.
//
// Importing the entry point is itself the arrangement under test, so this file
// imports it once at module scope and then asserts on what that import did.

import { describe, expect, it } from "vitest";
import "../../src/auto.js";
import { autoInstallModelContext } from "../../src/auto.js";

function surface(): EventTarget | undefined {
	return (document as unknown as Record<string, unknown>)["modelContext"] as
		| EventTarget
		| undefined;
}

describe("the auto-installing entry point in a real browser", () => {
	it("installed a surface at import time, before any explicit call", () => {
		// If this fails, the module's import-time call did not run, and every
		// other assertion in this file would be testing a surface that this
		// project installed by some other means.
		expect(surface()).toBeDefined();
	});

	it("produced an EventTarget, which the draft's IDL requires", () => {
		const context = surface();
		expect(context).toBeInstanceOf(EventTarget);
		expect(typeof context?.addEventListener).toBe("function");
		expect(typeof context?.dispatchEvent).toBe("function");
	});

	it("stands down on a repeated call rather than replacing the surface", () => {
		const before = surface();
		expect(autoInstallModelContext()).toBeUndefined();
		expect(surface()).toBe(before);
	});

	it("gives an agent a tool it can enumerate and invoke", async () => {
		// The surface is read as `unknown` and narrowed here rather than cast to
		// the interface, because `EventTarget` and `ModelContext` overlap too
		// little for a direct assertion to typecheck — and a cast that does
		// typecheck is exactly the thing that hides a signature change from the
		// compiler. The structural shape below is the draft's IDL for the three
		// methods, so a rename upstream fails this file rather than passing it.
		const context = surface() as unknown as {
			registerTool: (tool: {
				name: string;
				description: string;
				execute: (input: unknown) => Promise<unknown>;
			}) => Promise<undefined>;
			getTools: () => Promise<ReadonlyArray<{ name: string }>>;
			executeTool: (tool: unknown, input?: unknown) => Promise<string>;
		};

		await context.registerTool({
			name: "auto_echo",
			description: "returns the input it was given",
			execute: async (input: unknown) => input,
		});

		const tools = await context.getTools();
		const found = tools.find((tool) => tool.name === "auto_echo");
		expect(found).toBeDefined();
		if (found === undefined) {
			return;
		}

		// The draft's return type is Promise<DOMString> over a JSON
		// serialization, so the quotes are the specified behaviour rather than a
		// defect in the assertion.
		expect(await context.executeTool(found, { value: 7 })).toBe('{"value":7}');
	});

	it("notifies a change listener without a sleep", async () => {
		const context = surface() as unknown as EventTarget & {
			registerTool: (tool: {
				name: string;
				description: string;
				execute: () => Promise<unknown>;
			}) => Promise<undefined>;
		};
		const seen = new Promise<string>((resolve) => {
			context.addEventListener("toolchange", () => resolve("fired"), {
				once: true,
			});
		});
		await context.registerTool({
			name: "auto_notified",
			description: "exists to raise a change notification",
			execute: async () => null,
		});
		// Resolved by the event, not by a timer. A sleep here would be a flaky
		// test in CI and would hide the ordering the draft specifies.
		expect(await seen).toBe("fired");
	});
});
