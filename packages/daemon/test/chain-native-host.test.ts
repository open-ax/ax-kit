// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole chain, with the browser doing the part only a browser can do.
 *
 * Everything else in this package proves the wire formats agree. This proves
 * the product exists: a client spawns the daemon, the daemon opens a listener
 * and writes its discovery file, the browser launches the native host, the host
 * reads that file, the worker dials the loopback listener with the bearer, and
 * a tool on a real page runs.
 *
 * No port and no bearer are passed into this test. Anything the test supplies,
 * the product does not have to.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserContext, Worker } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * **The extension id is discovered, not declared.** Chromium derives it from the
 * load path for an unpacked extension, and the load path is a temporary
 * directory here. Knowing it before launch would mean pinning an id to a path
 * that does not exist yet, so the browser is launched twice: once to read the
 * id, once for real.
 *
 * **Registration is a registry key on Windows.** A manifest in the browser's
 * user-data directory is not a Windows mechanism — that was measured, not
 * assumed: the file present and the browser logging that it could not find it.
 * The key is written and removed in `finally`, so a failure mid-test leaves no
 * registration behind rather than a browser that has silently lost its host.
 */

const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const UNPACKED = join(REPO, "packages", "extension", "dist", "unpacked");
const CORE = join(REPO, "packages", "core", "dist", "index.mjs");
const DAEMON_BIN = join(REPO, "packages", "daemon", "bin", "ax-kit-daemon.mjs");
const BROKER = join(
	REPO,
	"packages",
	"daemon",
	"bin",
	"ax-kit-browser-host.mjs",
);
const HOST_NAME = "com.openax.axkit";
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const PROTOCOL_VERSION = "2026-07-28";

const PAGE = `
const mc = (await import("/core.mjs")).installModelContext(document);
await mc.registerTool({
	name: "viewCart",
	description: "Show the cart.",
	inputSchema: { type: "object", properties: { detailed: { type: "boolean" } } },
	execute: async (args) => ({ items: 3, received: args }),
});
globalThis.__ready = true;
`;

let root: string;
let page: import("node:http").Server;
let origin: string;
let context: BrowserContext | undefined;
let worker: Worker | undefined;
let daemon: ReturnType<typeof spawn>;
let extensionId = "";

function meta(): Record<string, unknown> {
	return {
		"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
		"io.modelcontextprotocol/clientCapabilities": {},
	};
}

function frame(
	id: number,
	method: string,
	params: Record<string, unknown>,
): string {
	return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

async function servePage(): Promise<void> {
	const core = readFileSync(CORE, "utf8");
	page = createServer((request, response) => {
		if ((request.url ?? "").startsWith("/core.mjs")) {
			response.writeHead(200, { "content-type": "text/javascript" });
			response.end(core);
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			`<!doctype html><html><body><script type="module">${PAGE}</script></body></html>`,
		);
	});
	await new Promise<void>((done) => {
		page.listen(0, "127.0.0.1", done);
	});
	const address = page.address();
	if (address === null || typeof address === "string") {
		throw new TypeError("fixture page has no port");
	}
	origin = `http://127.0.0.1:${address.port}`;
}

/** Read frames off the daemon's stdout until one with this id arrives. */
async function nextFrame(
	id: number,
	timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	let buffered = "";
	const onData = (chunk: Buffer): void => {
		buffered += chunk.toString("utf8");
	};
	daemon.stdout?.on("data", onData);
	try {
		for (;;) {
			for (const line of buffered.split("\n")) {
				if (line.trim().length === 0) {
					continue;
				}
				try {
					const parsed = JSON.parse(line) as Record<string, unknown>;
					if (parsed.id === id) {
						return parsed;
					}
				} catch {
					// A partial line at the end of the buffer; wait for more.
				}
			}
			if (Date.now() > deadline) {
				throw new Error(`no frame ${String(id)} within ${String(timeoutMs)}ms`);
			}
			await new Promise((done) => setTimeout(done, 25));
		}
	} finally {
		daemon.stdout?.off("data", onData);
	}
}

/** The first frame that answers with this id, ignoring anything else. */
async function call(
	id: number,
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	daemon.stdin?.write(frame(id, method, params));
	return await nextFrame(id);
}

async function launchBrowser(): Promise<void> {
	context = await chromium.launchPersistentContext(join(root, "profile"), {
		channel: "chromium",
		headless: false,
		env: { ...process.env, LOCALAPPDATA: root },
		args: [
			`--disable-extensions-except=${UNPACKED}`,
			`--load-extension=${UNPACKED}`,
		],
	});
	[worker] = context.serviceWorkers();
	if (worker === undefined) {
		worker = await context.waitForEvent("serviceworker");
	}
}

async function relayStatus(): Promise<string> {
	return await worker!.evaluate(() => {
		const scope = globalThis as unknown as Record<string, unknown>;
		const relay = scope.__axRelay as { state: { status: string } } | undefined;
		return relay === undefined ? "absent" : relay.state.status;
	});
}

beforeAll(async () => {
	// A file-scope hook runs even when every `describe` in the file is skipped,
	// so guarding the describe is not enough on its own. Without this the suite
	// launches a headful browser and shells out to `reg.exe` on a Linux runner,
	// and fails there for a reason that has nothing to do with the code.
	if (process.platform !== "win32") {
		return;
	}
	root = mkdtempSync(join(tmpdir(), "ax-chain-"));
	// The broker resolves its discovery directory from the environment it is
	// launched with, and a launched process inherits the browser's. Pointing
	// LOCALAPPDATA at a temporary directory is therefore what makes the whole
	// chain isolable: daemon, broker and discovery file all land here.
	await servePage();

	// Learn the extension id before registering anything, because the manifest's
	// allowed_origins has to name it.
	await launchBrowser();
	extensionId = new URL(worker!.url()).host;
	await context!.close();

	const shim = join(root, "host.cmd");
	writeFileSync(
		shim,
		[
			"@echo off",
			// %* forwards the caller's arguments. Without it the shim silently
			// drops the one the broker authenticates on, and the broker then
			// refuses every connection as though no browser had called it.
			`"${process.execPath}" "${BROKER}" %*`,
			"",
		].join("\r\n"),
	);
	const manifest = join(root, `${HOST_NAME}.json`);
	writeFileSync(
		manifest,
		JSON.stringify({
			name: HOST_NAME,
			description: "ax-kit chain",
			path: shim,
			type: "stdio",
			allowed_origins: [`chrome-extension://${extensionId}/`],
		}),
	);
	const registered = spawnSync(
		"reg.exe",
		["add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"],
		{ encoding: "utf8", windowsHide: true },
	);
	expect(registered.status, "registry registration").toBe(0);

	daemon = spawn(process.execPath, [DAEMON_BIN], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, LOCALAPPDATA: root },
	});
	await launchBrowser();

	const tab = await context!.newPage();
	await tab.goto(`${origin}/tools`);
	// The page sets this once it has installed its context and registered the
	// tool. Waited on because the assertion below depends on it, and a sleep
	// would be a different claim about timing.
	await tab.waitForFunction(() => {
		const scope = globalThis as unknown as Record<string, unknown>;
		return scope.__ready === true;
	});
}, 240_000);

afterAll(async () => {
	// Mirrors the guard in `beforeAll`: on a platform where nothing was set up,
	// there is nothing to tear down, and `reg delete` on a key that was never
	// written would be the only thing this suite did off Windows.
	if (process.platform !== "win32") {
		return;
	}
	spawnSync("reg.exe", ["delete", REG_KEY, "/f"], { windowsHide: true });
	daemon?.kill();
	await context!.close();
	await new Promise<void>((done) => {
		if (page === undefined) {
			done();
			return;
		}
		page.close(() => done());
	});
	if (root !== undefined) {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Windows only, and both the suite and its hooks say so rather than hiding it.
 *
 * Registration on Windows is a key under `HKEY_CURRENT_USER`, written with
 * `reg.exe` — so on any other platform the browser is never told where the host
 * is, and this file's `reg.exe` calls do not exist.
 *
 * Two guards are needed and neither is sufficient alone: Vitest runs a
 * file-scope `beforeAll` even when every `describe` in the file is skipped, so
 * the hooks are guarded separately from the suite.
 *
 * The alternative was to run it everywhere by writing each platform's real
 * registration location, which `defaultManifestDir` already knows how to build.
 * That is not done here because the macOS and Linux paths have not been run on
 * those platforms, and a green test that has never executed is worse than an
 * absent one. The gap is recorded rather than papered over.
 */
const WINDOWS_ONLY = process.platform === "win32" ? describe : describe.skip;

WINDOWS_ONLY(
	"the chain, with the browser doing the part only a browser can do",
	() => {
		it("finds the daemon through a host the browser launched", async () => {
			// No port and no bearer were passed into this test. The worker got both
			// from a file, through a process the browser started, because it asked.
			await expect
				.poll(async () => await relayStatus(), { timeout: 30_000 })
				.toBe("attached");
		});

		it("enumerates the page's real tools through the whole bridge", async () => {
			const response = await call(1, "tools/list", { _meta: meta() });
			const result = response.result as Record<string, unknown>;
			expect(result.resultType).toBe("complete");
			const tools = result.tools as ReadonlyArray<Record<string, unknown>>;
			expect(tools.map((tool) => tool.name)).toEqual(["viewCart"]);
			// The description is the page's own, not a fixture the test wrote.
			expect(tools[0]?.description).toBe("Show the cart.");
		}, 60_000);

		it("executes a tool and returns the page's real value", async () => {
			const response = await call(2, "tools/call", {
				_meta: meta(),
				name: "viewCart",
				arguments: { detailed: true },
			});
			const result = response.result as Record<string, unknown>;
			expect(result.resultType).toBe("complete");
			expect(result.isError).toBeUndefined();
			// The page's execute callback ran. This is its value, parsed.
			const payload = JSON.parse(
				String((result.content as ReadonlyArray<{ text: string }>)[0]?.text),
			) as Record<string, unknown>;
			expect(payload).toEqual({ items: 3, received: { detailed: true } });
		}, 60_000);
	},
);
