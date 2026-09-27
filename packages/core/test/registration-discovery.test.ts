// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ModelContext } from "../src/index.js";
import { installModelContext } from "../src/index.js";

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

function errorName(error: unknown): string {
	if (error instanceof DOMException) {
		return error.name;
	}
	if (error instanceof TypeError) {
		return "TypeError";
	}
	return `unexpected:${String(error)}`;
}

function raw(doc: Document): Record<string, unknown> {
	return doc as unknown as Record<string, unknown>;
}

function context(): ModelContext {
	const installed = raw(document).modelContext as ModelContext | undefined;
	if (installed === undefined) {
		throw new Error("document.modelContext is not installed");
	}
	return installed;
}

function tool(name: string): {
	name: string;
	description: string;
	execute: () => Promise<null>;
} {
	return {
		name,
		description: `${name} description`,
		execute: async () => null,
	};
}

describe("document.modelContext global", () => {
	it("is the same instance on every access", () => {
		expect(raw(document).modelContext).toBe(raw(document).modelContext);
	});

	it("is defined non-writable and non-configurable", () => {
		const descriptor = Object.getOwnPropertyDescriptor(
			document,
			"modelContext",
		);
		expect(descriptor?.writable).toBe(false);
		expect(descriptor?.configurable).toBe(false);
	});

	it("has no window or navigator alias", () => {
		const scope = globalThis as unknown as Record<string, unknown>;
		expect(scope.modelContext).toBeUndefined();
	});
});

describe("registerTool validation", () => {
	it("registers and lists a tool with copied fields", async () => {
		const mc = context();
		const schema: { type: string; properties: { q: { type: string } } } = {
			type: "object",
			properties: { q: { type: "string" } },
		};
		await mc.registerTool({
			...tool("reg_copy"),
			title: "Copy",
			inputSchema: schema,
			annotations: { readOnlyHint: true },
		});
		schema.properties.q = { type: "number" };
		const listed = await mc.getTools();
		const entry = listed.find((item) => item.name === "reg_copy");
		expect(entry?.title).toBe("Copy");
		expect(entry?.description).toBe("reg_copy description");
		expect(entry?.origin).toBe(document.location.origin);
		expect(entry?.window).toBe(document.defaultView);
		expect(entry?.inputSchema).toEqual({
			type: "object",
			properties: { q: { type: "string" } },
		});
		expect(entry?.annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: false,
			consequentialHint: false,
			debugging: false,
		});
	});

	it("defaults title to empty string and annotations to undefined", async () => {
		const mc = context();
		await mc.registerTool(tool("reg_defaults"));
		const entry = (await mc.getTools()).find(
			(item) => item.name === "reg_defaults",
		);
		expect(entry?.title).toBe("");
		expect(entry?.annotations).toBeUndefined();
		expect(entry?.inputSchema).toBeUndefined();
	});

	it("rejects duplicates with InvalidStateError", async () => {
		const mc = context();
		await mc.registerTool(tool("reg_dup"));
		expect(errorName(await errorOf(mc.registerTool(tool("reg_dup"))))).toBe(
			"InvalidStateError",
		);
	});

	it("rejects bad names and empty descriptions", async () => {
		const mc = context();
		for (const name of ["", "has space", "a/b", "x".repeat(129)]) {
			expect(errorName(await errorOf(mc.registerTool(tool(name))))).toBe(
				"InvalidStateError",
			);
		}
		expect(
			errorName(
				await errorOf(mc.registerTool({ ...tool("reg_ok"), description: "" })),
			),
		).toBe("InvalidStateError");
		await mc.registerTool(tool("reg_name_ok-1.v2_X"));
	});

	it("requires an execute callback", async () => {
		const mc = context();
		const { execute: _dropped, ...withoutExecute } = tool("reg_noexec");
		expect(
			errorName(
				await errorOf(
					mc.registerTool(
						withoutExecute as unknown as Parameters<
							ModelContext["registerTool"]
						>[0],
					),
				),
			),
		).toBe("TypeError");
	});

	it("rejects unserializable schemas with TypeError", async () => {
		const mc = context();
		const circular: Record<string, unknown> = { type: "object" };
		circular.self = circular;
		expect(
			errorName(
				await errorOf(
					mc.registerTool({ ...tool("reg_circular"), inputSchema: circular }),
				),
			),
		).toBe("TypeError");
		expect(
			(await mc.getTools()).find((item) => item.name === "reg_circular"),
		).toBeUndefined();
	});

	it("converts lone surrogates in titles", async () => {
		const mc = context();
		await mc.registerTool({ ...tool("reg_surrogate"), title: "\uD800x" });
		const entry = (await mc.getTools()).find(
			(item) => item.name === "reg_surrogate",
		);
		expect(entry?.title).toBe("\uFFFDx");
	});
});

describe("registration signal", () => {
	it("pre-aborted signals reject without registering", async () => {
		const mc = context();
		const controller = new AbortController();
		controller.abort();
		const error = await errorOf(
			mc.registerTool(tool("reg_preaborted"), { signal: controller.signal }),
		);
		expect(errorName(error)).toBe("AbortError");
		expect(
			(await mc.getTools()).find((item) => item.name === "reg_preaborted"),
		).toBeUndefined();
	});

	it("aborting unregisters the tool and notifies", async () => {
		const mc = context();
		const controller = new AbortController();
		let notified = 0;
		mc.addEventListener("toolchange", () => {
			notified += 1;
		});
		await mc.registerTool(tool("reg_abort"), { signal: controller.signal });
		const seen = notified;
		expect(
			(await mc.getTools()).some((item) => item.name === "reg_abort"),
		).toBe(true);
		controller.abort();
		expect(
			(await mc.getTools()).some((item) => item.name === "reg_abort"),
		).toBe(false);
		expect(notified).toBeGreaterThan(seen);
	});
});

describe("exposure and origins", () => {
	it("rejects untrustworthy or malformed exposedTo with SecurityError", async () => {
		const mc = context();
		expect(
			errorName(
				await errorOf(
					mc.registerTool(tool("reg_http"), {
						exposedTo: ["http://example.com"],
					}),
				),
			),
		).toBe("SecurityError");
		expect(
			errorName(
				await errorOf(
					mc.registerTool(tool("reg_badsyntax"), {
						exposedTo: ["::::"],
					}),
				),
			),
		).toBe("SecurityError");
	});

	it("keeps owner-visible tools with valid exposedTo", async () => {
		const mc = context();
		await mc.registerTool(tool("reg_exposed"), {
			exposedTo: ["https://example.com"],
		});
		expect(
			(await mc.getTools()).some((item) => item.name === "reg_exposed"),
		).toBe(true);
	});

	it("rejects invalid fromOrigins with SecurityError", async () => {
		const mc = context();
		expect(
			errorName(
				await errorOf(mc.getTools({ fromOrigins: ["http://example.com"] })),
			),
		).toBe("SecurityError");
	});

	it("still lists same-origin tools when fromOrigins names others", async () => {
		const mc = context();
		await mc.registerTool(tool("reg_fromorigins"));
		const listed = await mc.getTools({
			fromOrigins: ["https://example.com"],
		});
		expect(listed.some((item) => item.name === "reg_fromorigins")).toBe(true);
	});
});

describe("getTools ordering and isolation", () => {
	it("sorts ascending by code unit", async () => {
		const mc = context();
		await mc.registerTool(tool("sort_b"));
		await mc.registerTool(tool("sort_A"));
		await mc.registerTool(tool("sort_a"));
		const names = (await mc.getTools())
			.filter((item) => item.name.startsWith("sort_"))
			.map((item) => item.name);
		expect(names).toEqual(["sort_A", "sort_a", "sort_b"]);
	});

	it("keeps per-document state with origin-filtered visibility", async () => {
		const mc = context();
		const frame = document.createElement("iframe");
		document.body.appendChild(frame);
		const other = frame.contentDocument;
		if (other === null) {
			throw new Error("iframe has no document");
		}
		try {
			const otherContext = installModelContext(other);
			expect(otherContext).toBeDefined();
			expect(otherContext).not.toBe(mc);
			expect(otherContext).toBe(raw(other).modelContext);
			// Same name in two documents: neither shadows the other, because
			// each document owns its map. Same-origin frames see each
			// other's tools; state is what stays separate.
			await mc.registerTool({
				name: "iso_shared",
				description: "from-main",
				execute: async () => null,
			});
			await otherContext?.registerTool({
				name: "iso_shared",
				description: "from-frame",
				execute: async () => null,
			});
			const mainShared = (await mc.getTools()).filter(
				(item) => item.name === "iso_shared",
			);
			expect(mainShared.map((item) => item.description).sort()).toEqual([
				"from-frame",
				"from-main",
			]);
			// Two records under one name: neither document shadowed the other.
			const frameShared = ((await otherContext?.getTools()) ?? []).filter(
				(item) => item.name === "iso_shared",
			);
			// This DOM cannot climb to the top document, so the frame sees
			// its own record here; symmetric visibility runs in browser mode.
			expect(frameShared.map((item) => item.description)).toContain(
				"from-frame",
			);
		} finally {
			frame.remove();
		}
	});

	it("rejects registration on documents without a browsing context", async () => {
		const mc = context();
		const detached = document.implementation.createHTMLDocument("detached");
		const detachedContext = installModelContext(detached);
		expect(detachedContext).toBeDefined();
		expect(
			errorName(
				await errorOf(
					detachedContext?.registerTool(tool("iso_detached")) ??
						Promise.resolve(),
				),
			),
		).toBe("InvalidStateError");
		expect(mc).not.toBe(detachedContext);
	});

	it("fires toolchange on registration", async () => {
		const mc = context();
		let count = 0;
		const onChange = (): void => {
			count += 1;
		};
		mc.addEventListener("toolchange", onChange);
		await mc.registerTool(tool("reg_event"));
		expect(count).toBe(1);
		mc.removeEventListener("toolchange", onChange);
	});
});
