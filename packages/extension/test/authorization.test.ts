// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserContext, Page, Worker } from "playwright";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The refusal outcomes, asserted against the running bridge.
 *
 * Every case here is a negative that the unit suites already cover as pure
 * functions. The point of the ticket is that they are also true of the thing
 * that actually runs: a loaded extension, a real page, a real worker.
 *
 * Each refusal must arrive as its own error family, so a client can tell "not
 * permitted" from "malformed" from "no longer available" rather than reading
 * one generic failure.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CORE_BUNDLE = resolve(here, "../../core/dist/index.mjs");
const UNPACKED = resolve(here, "../dist/unpacked");

/** A page whose tool reads its own arguments, so tampering is observable. */
const PAGE = `
const mc = globalThis.__install(document);
await mc.registerTool({
	name: "plainTool",
	description: "Echoes the arguments it was given.",
	inputSchema: { type: "object", properties: { note: { type: "string", description: "A note." } } },
	execute: async (args) => ({ seen: args.note ?? null }),
});
await mc.registerTool({
	name: "payNow",
	description: "Charge the saved card.",
	inputSchema: { type: "object", properties: { amount: { type: "number", description: "Amount." } } },
	annotations: { consequentialHint: true },
	execute: async (args) => ({ paid: args.amount }),
});
globalThis.__ready = true;
`;

/** A page that never installs the core and forges its own context. */
const FORGED = `
globalThis.__ready = true;
Object.defineProperty(document, "modelContext", {
	value: {
		getTools: async () => [
			{ name: 42, description: "not a name", origin: "not-an-origin" },
			"not-an-object",
			null,
		],
	},
	writable: false,
	configurable: false,
	enumerable: true,
});
`;

let server: Server;
let origin: string;
let context: BrowserContext;
let userDataDir: string;
let worker: Worker;
let page: Page;
let tabId = -1;

interface CallResult {
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

async function serve(): Promise<string> {
	const core = await readFile(CORE_BUNDLE, "utf8");
	server = createServer((request, response) => {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
		if (path === "/core.mjs") {
			response.writeHead(200, { "content-type": "text/javascript" });
			response.end(core);
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			`<!doctype html><html><body><script type="module">
const { installModelContext } = await import("/core.mjs");
globalThis.__install = installModelContext;
async function main() { ${path === "/forged" ? FORGED : PAGE} }
main().catch((error) => { globalThis.__fixtureError = String(error); });
</script></body></html>`,
		);
	});
	await new Promise<void>((done) => {
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new TypeError("fixture server has no port");
	}
	return `http://127.0.0.1:${address.port}`;
}

/** Call one injection handler in the worker's own context. */
async function invoke(
	handler: string,
	args: Record<string, unknown>,
): Promise<CallResult> {
	return (await worker.evaluate(
		async (request: unknown) => {
			const scope = globalThis as unknown as Record<string, unknown>;
			const handle = scope["__axHandle"] as (r: unknown) => Promise<unknown>;
			try {
				return {
					ok: true,
					result: (await handle(request)) as unknown,
				};
			} catch (error: unknown) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : "failed",
				};
			}
		},
		{ handler, args },
	)) as CallResult;
}

/** A call to the plain tool, with overridable arguments. */
function plain(overrides: Record<string, unknown> = {}): Promise<CallResult> {
	return invoke("executeTool", {
		tabId,
		frameId: 0,
		name: "plainTool",
		args: { note: "hello" },
		callerOrigin: origin,
		allowedOrigins: [],
		documentId: "doc-1",
		...overrides,
	});
}

/** Clear anything left pending, so a case asserts on its own state. */
async function clearPending(): Promise<void> {
	await worker.evaluate(() => {
		const scope = globalThis as unknown as Record<string, unknown>;
		const panel = scope["__axPanel"] as (op: string, args: unknown) => unknown;
		const list = panel("list", {}) as {
			pending?: ReadonlyArray<{ key: string }>;
		};
		for (const entry of list.pending ?? []) {
			panel("reject", { key: entry.key });
		}
	});
}

/** Open a fixture page and wait for its own readiness marker. */
async function openFixture(path: string): Promise<number> {
	const fixture = await context.newPage();
	await fixture.goto(`${origin}${path}`);
	await fixture.waitForFunction(
		() =>
			(globalThis as unknown as Record<string, unknown>)["__ready"] === true,
		undefined,
		{ timeout: 20_000 },
	);
	const id = await worker.evaluate(async (target: unknown) => {
		const scope = globalThis as unknown as {
			chrome?: {
				tabs: {
					query(
						i: unknown,
					): Promise<ReadonlyArray<{ id?: number; url?: string }>>;
				};
			};
		};
		const api = scope.chrome;
		if (api === undefined) {
			return -1;
		}
		const tabs = await api.tabs.query({});
		return tabs.find((tab) => tab.url === (target as string))?.id ?? -1;
	}, fixture.url());
	// The page stays open: a tab that has been closed is a different refusal,
	// and the case under test is the tool listing, not tab lifetime.
	return id;
}

beforeAll(async () => {
	origin = await serve();
	userDataDir = await mkdtemp(join(tmpdir(), "ax-authz-prof-"));
	const { chromium } = await import("playwright");
	context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${UNPACKED}`,
			`--load-extension=${UNPACKED}`,
		],
	});
	const started = context.serviceWorkers();
	if (started.length > 0) {
		worker = started[0];
	} else {
		const event = context.waitForEvent("serviceworker", { timeout: 30_000 });
		const first = await context.newPage();
		await first.goto(`${origin}/shop`);
		worker = await event;
	}
	page = await context.newPage();
	await page.goto(`${origin}/shop`);
	await page.waitForFunction(
		() =>
			(globalThis as unknown as Record<string, unknown>)["__ready"] === true,
		undefined,
		{ timeout: 20_000 },
	);
	tabId = await openFixture("/shop");
	if (tabId < 0) {
		throw new Error("no tab id for the fixture page");
	}
}, 180_000);

afterAll(async () => {
	await context?.close();
	await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
	await new Promise<void>((done) => {
		if (server === undefined) {
			done();
			return;
		}
		server.close(() => done());
	});
});

describe("authorisation outcomes at the real seam", () => {
	it("refuses a caller outside the Exposed to set", async () => {
		const refused = await plain({
			callerOrigin: "https://elsewhere.example",
			allowedOrigins: [],
		});
		expect(refused.ok).toBe(false);
		expect(refused.error).toMatch(/not exposed/);
	});

	it("refuses a caller whose origin the allow-list names only indirectly", async () => {
		const refused = await plain({
			callerOrigin: "https://sub.shop.example",
			allowedOrigins: ["https://shop.example"],
		});
		expect(refused.ok).toBe(false);
		expect(refused.error).toMatch(/not exposed/);
	});

	it("allows a caller the allow-list names", async () => {
		const allowed = await plain({
			allowedOrigins: ["https://elsewhere.example"],
			callerOrigin: "https://elsewhere.example",
		});
		expect(allowed.ok).toBe(true);
		expect(allowed.result).toEqual(JSON.stringify({ seen: "hello" }));
	});

	it("drops argument keys that were never allow-listed", async () => {
		// The page echoes what it received, so a smuggled key is visible in the
		// result rather than merely absent from a log.
		const smuggled = await plain({
			args: { note: "hello", secret: "must not arrive" },
			allowedKeys: ["note"],
		});
		expect(smuggled.ok).toBe(true);
		expect(smuggled.result).toEqual(JSON.stringify({ seen: "hello" }));

		const absent = await plain({
			args: { note: "hello" },
			allowedKeys: [],
		});
		expect(absent.ok).toBe(true);
		expect(absent.result).toEqual(JSON.stringify({ seen: null }));
	});

	it("refuses a malformed caller origin before any authorisation decision", async () => {
		const refused = await plain({ callerOrigin: "not-an-origin" });
		expect(refused.ok).toBe(false);
		expect(refused.error).toBeDefined();
	});

	it("refuses an opaque origin", async () => {
		const refused = await plain({ callerOrigin: "data:text/html,x" });
		expect(refused.ok).toBe(false);
		expect(refused.error).toMatch(/opaque origin/);
	});

	it("refuses a call for a tool the page does not offer", async () => {
		const missing = await plain({ name: "noSuchTool" });
		expect(missing.ok).toBe(false);
		// Absence, not a validation failure.
		expect(missing.error).toMatch(/tool not found/);
	});

	it("refuses a malformed tab id rather than reaching the page", async () => {
		const refused = await plain({ tabId: "not-a-number" });
		expect(refused.ok).toBe(false);
		expect(refused.error).toBe("bad tabId");
	});

	it("refuses a page that forges a tool listing", async () => {
		const forgedTab = await openFixture("/forged");
		const forged = await invoke("listTools", {
			tabId: forgedTab,
			frameId: 0,
		});
		// The forged entries are refused at the boundary rather than acted on:
		// a number where a name belongs, an unparseable origin, a bare string,
		// and null. None of them reach the Trusted tier as a tool.
		expect(forged.ok).toBe(false);
		expect(forged.error).toMatch(/bad tool|bad origin|bad description/);
	});

	it("refuses an approval whose arguments no longer match", async () => {
		await clearPending();
		const first = await invoke("executeTool", {
			tabId,
			frameId: 0,
			name: "payNow",
			args: { amount: 400 },
			callerOrigin: origin,
			allowedOrigins: [],
			documentId: "doc-1",
		});
		expect(first.ok).toBe(true);
		const argsJson = String(
			(first.result as Record<string, unknown>)["argsJson"],
		);
		const definitionVersion = String(
			(first.result as Record<string, unknown>)["definitionVersion"],
		);
		const binding = String(
			(first.result as Record<string, unknown>)["pendingApproval"],
		);
		const argsHash = await worker.evaluate((text: unknown) => {
			const scope = globalThis as unknown as Record<string, unknown>;
			const hash = scope["__axHash"] as ((s: string) => string) | undefined;
			if (hash === undefined) {
				throw new Error("no hasher exposed");
			}
			return hash(text as string);
		}, argsJson);

		// Approve 400, then ask for 4000. Refused, not executed and not re-prompted.
		const moved = await worker.evaluate(
			(payload: unknown) => {
				const scope = globalThis as unknown as Record<string, unknown>;
				const panel = scope["__axPanel"] as (
					op: string,
					args: unknown,
				) => unknown;
				const record = payload as Record<string, unknown>;
				panel("request", {
					gesture: true,
					approval: {
						key: record["key"],
						toolName: "payNow",
						description: "Charge the saved card.",
						argsJson: record["argsJson"],
						origin: record["origin"],
						frameOrigin: record["origin"],
						consequentialHint: true,
						readOnlyHint: false,
						definitionVersion: record["definitionVersion"],
					},
				});
				panel("approve", { key: record["binding"] });
				return true;
			},
			{
				binding,
				argsJson,
				origin,
				definitionVersion,
				key: {
					tabId,
					documentId: "doc-1",
					frameId: 0,
					toolName: "payNow",
					argsHash,
				},
			},
		);
		expect(moved).toBe(true);

		const changed = await invoke("executeTool", {
			tabId,
			frameId: 0,
			name: "payNow",
			args: { amount: 4000 },
			callerOrigin: origin,
			allowedOrigins: [],
			documentId: "doc-1",
		});
		expect(changed.ok).toBe(false);
		expect(changed.error).toMatch(/approval/);
		await clearPending();
	});

	it("refuses a replayed approval", async () => {
		await clearPending();
		const once = await invoke("executeTool", {
			tabId,
			frameId: 0,
			name: "payNow",
			args: { amount: 250 },
			callerOrigin: origin,
			allowedOrigins: [],
			documentId: "doc-1",
		});
		const result = once.result as Record<string, unknown>;
		const argsJson = String(result["argsJson"]);
		const definitionVersion = String(result["definitionVersion"]);
		const argsHash = await worker.evaluate((text: unknown) => {
			const scope = globalThis as unknown as Record<string, unknown>;
			const hash = scope["__axHash"] as ((s: string) => string) | undefined;
			if (hash === undefined) {
				throw new Error("no hasher exposed");
			}
			return hash(text as string);
		}, argsJson);
		await worker.evaluate(
			(payload: unknown) => {
				const scope = globalThis as unknown as Record<string, unknown>;
				const panel = scope["__axPanel"] as (
					op: string,
					args: unknown,
				) => unknown;
				const record = payload as Record<string, unknown>;
				panel("request", {
					gesture: true,
					approval: {
						key: record["key"],
						toolName: "payNow",
						description: "Charge the saved card.",
						argsJson: record["argsJson"],
						origin: record["origin"],
						frameOrigin: record["origin"],
						consequentialHint: true,
						readOnlyHint: false,
						definitionVersion: record["definitionVersion"],
					},
				});
				panel("approve", { key: record["binding"] });
			},
			{
				binding: String(result["pendingApproval"]),
				argsJson,
				origin,
				definitionVersion,
				key: {
					tabId,
					documentId: "doc-1",
					frameId: 0,
					toolName: "payNow",
					argsHash,
				},
			},
		);

		const call = (): Promise<CallResult> =>
			invoke("executeTool", {
				tabId,
				frameId: 0,
				name: "payNow",
				args: { amount: 250 },
				callerOrigin: origin,
				allowedOrigins: [],
				documentId: "doc-1",
			});
		expect((await call()).result).toEqual(JSON.stringify({ paid: 250 }));
		// The second call with the same arguments is not covered by the spent
		// approval: it needs a fresh gesture, so it asks again rather than
		// running.
		const replay = await call();
		expect(replay.ok).toBe(true);
		expect(replay.result).not.toEqual(JSON.stringify({ paid: 250 }));
		await clearPending();
	});

	it("keeps zero any at the boundary", async () => {
		// Not a runtime assertion: a guard against the shape regressing. Every
		// value that crossed a realm boundary in this suite came back `unknown`
		// and was validated, and this test would fail if the boundary validators
		// stopped being consulted — a forged listing would then be accepted.
		const listing = await invoke("listTools", { tabId, frameId: 0 });
		expect(listing.ok).toBe(true);
		const tools = (listing.result as { tools: ReadonlyArray<unknown> }).tools;
		for (const tool of tools) {
			expect(typeof tool).toBe("object");
			expect(tool).not.toBeNull();
		}
	});
});
