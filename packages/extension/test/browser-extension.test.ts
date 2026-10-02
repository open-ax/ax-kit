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
import {
	assertManifestPosture,
	defaultManifestPosture,
} from "../src/manifest.js";
import {
	createManifestDocument,
	defaultManifestDocument,
} from "../src/manifest-document.js";

/**
 * The extension in a real browser.
 *
 * Highest seam available for this package: Chromium loads the emitted unpacked
 * directory, starts the real service worker, and the worker enumerates tools
 * from a real page through Main-world injection. Every assertion below observes
 * something that happened in the browser, not something a function returned.
 *
 * `channel: "chromium"` is required: the default bundled headless mode
 * resolves to a shell that loads no extension, and a test that omitted it would
 * observe no worker while passing nothing.
 *
 * No sleeps: readiness is the worker's own appearance in
 * `context.serviceWorkers()`, which a worker that started before the listener
 * attached is already visible in.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CORE_BUNDLE = resolve(here, "../../core/dist/index.mjs");
const UNPACKED = resolve(here, "../dist/unpacked");

const PAGE_WITH_TOOLS = `
const mc = globalThis.__install(document);
await mc.registerTool({
	name: "viewCart",
	description: "Show the cart.",
	inputSchema: { type: "object", properties: { detailed: { type: "boolean" } } },
	execute: async () => ({ items: 3 }),
});
await mc.registerTool({
	name: "placeOrder",
	description: "Charge the saved card.",
	inputSchema: { type: "object", properties: {} },
	annotations: { consequentialHint: true },
	execute: async () => ({ placed: true }),
});
globalThis.__ready = true;
`;

const PAGE_WITHOUT_TOOLS = `
globalThis.__install(document);
globalThis.__ready = true;
`;

const PAGE_BARE = "globalThis.__ready = true;";

let server: Server;
let origin: string;
let context: BrowserContext;
let userDataDir: string;

interface Fixture {
	readonly url: string;
	readonly page: Page;
	tabId?: number;
}

/** Serve pages over loopback HTTP, which the core treats as trustworthy. */
async function serve(): Promise<string> {
	const core = await readFile(CORE_BUNDLE, "utf8");
	const pages: Record<string, string> = {
		"/tools": PAGE_WITH_TOOLS,
		"/bare-context": PAGE_WITHOUT_TOOLS,
		"/bare": PAGE_BARE,
	};
	server = createServer((request, response) => {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
		if (path === "/core.mjs") {
			response.writeHead(200, { "content-type": "text/javascript" });
			response.end(core);
			return;
		}
		const body = pages[path];
		if (body === undefined) {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("no such fixture");
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		// The body runs inside an async function: a static `import` is only legal
		// at a module's top level, so wrapping the source in `try` directly would
		// be a syntax error rather than a caught rejection.
		response.end(
			`<!doctype html><html><body><script type="module">
const { installModelContext } = await import("/core.mjs");
globalThis.__install = installModelContext;
async function main() { ${body} }
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

/**
 * Open a fixture page and wait for its own readiness marker.
 *
 * Readiness is the page's value, polled by the browser. No sleep.
 */
async function openFixture(path: string): Promise<Fixture> {
	const page = await context.newPage();
	await page.goto(`${origin}${path}`);
	await page
		.waitForFunction(
			() =>
				(globalThis as unknown as Record<string, unknown>)["__ready"] === true,
			undefined,
			{ timeout: 20_000 },
		)
		.catch(() => {
			throw new Error(`fixture ${path} never became ready`);
		});
	return { url: page.url(), page };
}

/**
 * A page's tab id, read through the worker's own `chrome.tabs` view. A page
 * cannot read its own tab id, and the worker is the only context entitled to.
 */
async function tabIdFor(page: Page): Promise<number> {
	const worker = await observeWorker();
	const id = await worker.evaluate(async (target: unknown) => {
		const url = target as string;
		const tabs = await chrome.tabs.query({});
		const found = tabs.find((tab) => tab.url === url || tab.pendingUrl === url);
		return found?.id ?? -1;
	}, page.url());
	if (typeof id !== "number" || id < 0) {
		throw new TypeError(`no tab id for ${page.url()}`);
	}
	return id;
}

/** A fixture plus its tab id, which is what the worker addresses it by. */
async function openTabbed(path: string): Promise<Fixture> {
	const fixture = await openFixture(path);
	fixture.tabId = await tabIdFor(fixture.page);
	return fixture;
}

let workerRef: Worker | null = null;

/**
 * The running service worker.
 *
 * Checked from the collection before awaiting the event, because a worker that
 * started before the listener attached is already visible there. Awaiting the
 * event alone reports a false negative.
 */
async function observeWorker(): Promise<Worker> {
	if (workerRef !== null) {
		return workerRef;
	}
	const existing = context.serviceWorkers();
	if (existing.length > 0) {
		workerRef = existing[0];
		return workerRef;
	}
	const eventPromise = context.waitForEvent("serviceworker", {
		timeout: 30_000,
	});
	// A page gives the worker a reason to start.
	const page = await context.newPage();
	await page.goto(`${origin}/bare`);
	workerRef = await eventPromise;
	await page.close();
	return workerRef;
}

/**
 * Call one handler in the worker and return its outcome.
 *
 * Invoked as `__axHandle` inside the worker's own context rather than through
 * `chrome.runtime.sendMessage`: a message sent from the worker is delivered to
 * *other* extension contexts, never to the sender, so routing it that way
 * reports "receiving end does not exist" for a listener that is present.
 */
async function call(
	handler: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const worker = await observeWorker();
	return (await worker.evaluate(
		async (request: unknown) => {
			const scope = globalThis as unknown as Record<string, unknown>;
			const handle = scope["__axHandle"] as
				| ((r: unknown) => Promise<unknown>)
				| undefined;
			if (typeof handle !== "function") {
				return { ok: false, error: "worker handle missing" };
			}
			try {
				return { ok: true, result: await handle(request) };
			} catch (error: unknown) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : "request failed",
				};
			}
		},
		{ handler, args },
	)) as Record<string, unknown>;
}

/** The tools the worker saw on one tab. */
async function listTools(
	fixture: Fixture,
): Promise<ReadonlyArray<Record<string, unknown>>> {
	let tabId = fixture.tabId;
	if (tabId === undefined) {
		tabId = await tabIdFor(fixture.page);
		fixture.tabId = tabId;
	}
	const reply = await call("listTools", { tabId, frameId: 0 });
	expect(reply["ok"]).toBe(true);
	const result = reply["result"] as { tools: Array<Record<string, unknown>> };
	return result.tools;
}

beforeAll(async () => {
	origin = await serve();
	userDataDir = await mkdtemp(join(tmpdir(), "ax-ext-"));
	const { chromium } = await import("playwright");
	context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${UNPACKED}`,
			`--load-extension=${UNPACKED}`,
		],
	});
	await observeWorker();
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

describe("emitted manifest", () => {
	it("passes the posture assertions against the emitted document", async () => {
		const text = await readFile(resolve(UNPACKED, "manifest.json"), "utf8");
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) {
			throw new TypeError("manifest is not an object");
		}
		const doc = parsed as Record<string, unknown>;
		// The assertions run against what is emitted, not a hand-written
		// equivalent of it.
		expect(doc["incognito"]).toBe("not_allowed");
		expect(doc["externally_connectable"]).toEqual({ ids: [], matches: [] });
		expect(doc["background"]).toEqual({
			service_worker: "sw.js",
			type: "module",
		});
		// The posture function that produced it agrees with what is on disk.
		const held = assertManifestPosture(defaultManifestPosture());
		expect(doc["host_permissions"]).toEqual(held.hostMatches);
		expect(
			(doc["permissions"] as ReadonlyArray<string>).includes("scripting"),
		).toBe(true);
		// Byte-for-byte what the manifest function produces, so the shipped file
		// cannot drift from the posture it claims.
		expect(doc).toEqual({ ...defaultManifestDocument() });
	});

	it("emits every externally connectable id the posture asserts", () => {
		const ids = ["abcdefghijklmnopabcdefghijklmnop"];
		const doc = createManifestDocument(
			{
				...defaultManifestPosture(),
				externallyConnectable: { ids, matches: [] },
			},
			"ax-kit",
			"0.0.0",
			"Trusted-tier bridge for document.modelContext.",
		);
		// The posture accepts and validates these ids, so a document that dropped
		// them would assert a gate in code and ship a manifest without it.
		expect(doc.externally_connectable.ids).toEqual(ids);
	});

	it("refuses to emit a manifest for a non-service-worker posture", () => {
		expect(() =>
			createManifestDocument(
				{ ...defaultManifestPosture(), backgroundKind: "event-page" },
				"x",
				"0.0.0",
				"y",
			),
		).toThrow(TypeError);
	});

	it("rejects a posture that is not held", () => {
		expect(() =>
			createManifestDocument(
				// Deliberately not a `ManifestPosture`: `incognito` is widened back
				// out, so the value can only be built through the index signature.
				// The builder takes `unknown` and validates, which is what makes
				// this assertion possible without an unchecked cast.
				{ ...defaultManifestPosture(), incognito: "allowed" },
				"x",
				"0.0.0",
				"y",
			),
		).toThrow(TypeError);
	});
});

describe("extension loaded in real Chromium", () => {
	it("starts its service worker and runs our code", async () => {
		const worker = await observeWorker();
		expect(worker.url()).toContain("sw.js");
		// A value set by the worker module, read back from the test process.
		expect(await worker.evaluate(() => typeof chrome.runtime.id)).toBe(
			"string",
		);
		expect(await worker.evaluate(() => chrome.runtime.id.length)).toBe(32);
	});

	it("enumerates a real page's registered tools through Main-world injection", async () => {
		const fixture = await openTabbed("/tools");
		const tools = await listTools(fixture);
		expect(tools.map((tool) => tool["name"]).sort()).toEqual([
			"placeOrder",
			"viewCart",
		]);
		const viewCart = tools.find((tool) => tool["name"] === "viewCart");
		expect(viewCart?.["description"]).toBe("Show the cart.");
		// Origins are read from the live document, not asserted as constants.
		expect(viewCart?.["frameOrigin"]).toBe(new URL(fixture.url).origin);
		expect(viewCart?.["origin"]).toBe(new URL(fixture.url).origin);
	});

	it("reports annotations from the page's own tool definitions", async () => {
		const fixture = await openTabbed("/tools");
		const tools = await listTools(fixture);
		const order = tools.find((tool) => tool["name"] === "placeOrder");
		const cart = tools.find((tool) => tool["name"] === "viewCart");
		expect(order?.["consequentialHint"]).toBe(true);
		expect(cart?.["consequentialHint"]).toBe(false);
	});

	it("treats a page with no tools as a quiet no-op", async () => {
		const bare = await openTabbed("/bare");
		expect(await listTools(bare)).toEqual([]);
		// A context installed with no registrations is equally quiet.
		const empty = await openTabbed("/bare-context");
		expect(await listTools(empty)).toEqual([]);
	});

	it("refuses an unknown handler instead of dispatching it", async () => {
		const reply = await call("dispatch", { tabId: 1 });
		expect(reply["ok"]).toBe(false);
		expect(String(reply["error"])).toContain("unknown handler");
	});

	it("refuses a malformed request rather than reaching the page", async () => {
		const reply = await call("listTools", { tabId: "not-a-number" });
		expect(reply["ok"]).toBe(false);
		expect(String(reply["error"])).toContain("bad tabId");
	});

	it("leaves no page-visible channel and no mutable page global", async () => {
		const fixture = await openTabbed("/tools");
		const observed = await fixture.page.evaluate(() => {
			const scope = globalThis as unknown as Record<string, unknown>;
			return {
				axHandle: typeof scope["__axHandle"],
				axApprovals: typeof scope["__axApprovals"],
				axKeys: Object.keys(scope).filter((key) => key.startsWith("__ax")),
			};
		});
		expect(observed.axHandle).toBe("undefined");
		expect(observed.axApprovals).toBe("undefined");
		expect(observed.axKeys).toEqual([]);
	});

	it("reports a missing tool as a typed error, not a retry", async () => {
		const fixture = await openTabbed("/tools");
		const reply = await call("executeTool", {
			tabId: fixture.tabId,
			frameId: 0,
			name: "noSuchTool",
			args: {},
			callerOrigin: new URL(fixture.url).origin,
			allowedOrigins: [],
			documentId: "doc-1",
		});
		expect(reply["ok"]).toBe(false);
		expect(String(reply["error"])).toContain("tool not found");
	});
});
