// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Transport } from "../src/lifecycle.js";
import { startTransport } from "../src/lifecycle.js";

/**
 * A real page against the real listener.
 *
 * The bearer and the origin gate are both unit-tested from sockets, where the
 * `Origin` header is hand-set. A socket test cannot show what a page sees,
 * because a page never sets its own origin — the browser does — and never
 * reads a refusal body the preflight already withheld. This file drives a real
 * page in real headless Chromium and observes the refusal from inside it.
 *
 * Scope, stated so it is not overread: this proves what the *listener* refuses.
 * It does not prove the extension's Trusted tier refuses anything — that is
 * `packages/extension/test/authorization.test.ts` — and it does not prove a
 * page cannot read the discovery file, which holds by the platform (a page has
 * no filesystem) rather than by any code here. Where the test grants the page
 * the bearer through `evaluate`, that is knowledge the page could never obtain
 * itself; the grant is the adversarial case, not the setup.
 *
 * The gate under test is shared: `handleRequest` checks origin and bearer
 * before routing, so a verdict on `/pull` is the verdict every route would
 * give. The MCP endpoint's bearer enforcement from sockets is already covered
 * in `mcp-http.test.ts`.
 */

const FIXTURE =
	"<!doctype html><html><body><h1>adversarial page</h1></body></html>";

/** A hostname that resolves to loopback but is not a loopback origin. */
const FOREIGN_HOST = "page.test";

/** A well-formed extension origin a page might wish it could present. */
const EXTENSION_ORIGIN = "chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik";

interface PageFetchInit {
	readonly bearer: string | null;
	readonly forgeOrigin: string | null;
}

interface PageFetchOutcome {
	readonly rejected: boolean;
	readonly status: number | null;
	readonly body: string | null;
}

let dir: string;
let transport: Transport | undefined;
let fixture: Server | undefined;
let fixturePort = 0;
let browser: Browser | undefined;

function listen(server: Server, host: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, host, () => {
			server.off("error", reject);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new TypeError("fixture has no port"));
				return;
			}
			resolve(address.port);
		});
	});
}

/** One fetch executed inside the page, with the page's own origin. */
async function fetchInPage(
	page: Page,
	init: PageFetchInit,
): Promise<PageFetchOutcome> {
	const port = transport?.port ?? 0;
	return await page.evaluate(
		async ({
			daemonPort,
			fetchInit,
		}: {
			daemonPort: number;
			fetchInit: PageFetchInit;
		}): Promise<PageFetchOutcome> => {
			const headers: Record<string, string> = {
				...(fetchInit.bearer !== null
					? { "x-ax-bearer": fetchInit.bearer }
					: {}),
				...(fetchInit.forgeOrigin !== null
					? { Origin: fetchInit.forgeOrigin }
					: {}),
			};
			try {
				const response = await fetch(
					`http://127.0.0.1:${String(daemonPort)}/pull`,
					{ headers },
				);
				return {
					rejected: false,
					status: response.status,
					body: await response.text(),
				};
			} catch (error: unknown) {
				return {
					rejected: true,
					status: null,
					body: error instanceof Error ? error.message : "unknown failure",
				};
			}
		},
		{ daemonPort: port, fetchInit: init },
	);
}

async function openPage(origin: string): Promise<Page> {
	if (browser === undefined) {
		throw new TypeError("browser did not launch");
	}
	const page = await browser.newPage();
	await page.goto(origin, { waitUntil: "load" });
	return page;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ax-page-isolation-"));
	// Idle is answered at once rather than held: nothing is queued and nothing
	// ever will be, so holding the pull open would only spend the test's own
	// time budget proving the hold works.
	transport = await startTransport({
		discoveryDir: dir,
		bridge: {
			waitForEnvelope: () => Promise.resolve(null),
			deliver: () => {},
			clientAttached: () => false,
		},
	});
	fixture = createServer((request, response) => {
		if (request.url === "/echo-origin") {
			// What the server received, not what the page claims it sent.
			// A forged `Origin` is a forbidden header: the browser replaces
			// it with the page's own before it reaches the wire.
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(request.headers.origin ?? "");
			return;
		}
		if (request.url === "/health") {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("ok");
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(FIXTURE);
	});
	fixturePort = await listen(fixture, "127.0.0.1");
	// The mapping is what makes the foreign origin reachable without touching
	// machine state: `page.test` answers on loopback, but its origin is not
	// one, so the gate must refuse it.
	browser = await chromium.launch({
		args: [`--host-resolver-rules=MAP ${FOREIGN_HOST} 127.0.0.1`],
	});
}, 120_000);

afterAll(async () => {
	await browser?.close();
	await new Promise<void>((done) => {
		if (fixture === undefined) {
			done();
			return;
		}
		fixture.close(() => done());
	});
	await transport?.close().catch(() => {});
	if (dir !== undefined) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

describe("a page against the daemon listener", () => {
	it("refuses a request with no bearer, observably from the page", async () => {
		const page = await openPage(`http://127.0.0.1:${String(fixturePort)}/`);
		try {
			const outcome = await fetchInPage(page, {
				bearer: null,
				forgeOrigin: null,
			});
			expect(outcome.rejected).toBe(false);
			expect(outcome.status).toBe(403);
			expect(outcome.body).toBe("bad bearer");
		} finally {
			await page.close();
		}
	});

	it("refuses a wrong bearer byte-identically to an absent one", async () => {
		const page = await openPage(`http://127.0.0.1:${String(fixturePort)}/`);
		try {
			const absent = await fetchInPage(page, {
				bearer: null,
				forgeOrigin: null,
			});
			const wrong = await fetchInPage(page, {
				bearer: "wrong",
				forgeOrigin: null,
			});
			expect(absent.status).toBe(403);
			expect(wrong.status).toBe(403);
			expect(wrong.body).toBe(absent.body);
		} finally {
			await page.close();
		}
	});

	it("admits a loopback page holding the bearer: the bearer is the boundary there", async () => {
		// Stated as admission, not as failure: on a loopback origin the gate
		// passes and only the bearer decides. A page served from loopback that
		// somehow learned the bearer is inside, which is why the bearer lives
		// in a 0600 file no page can read rather than in a check the listener
		// could do without it.
		const page = await openPage(`http://127.0.0.1:${String(fixturePort)}/`);
		try {
			if (transport === undefined) {
				throw new TypeError("transport did not start");
			}
			const outcome = await fetchInPage(page, {
				bearer: transport.bearer,
				forgeOrigin: null,
			});
			expect(outcome.rejected).toBe(false);
			expect(outcome.status).toBe(204);
		} finally {
			await page.close();
		}
	});

	it("refuses a foreign page even with the correct bearer", async () => {
		const page = await openPage(
			`http://${FOREIGN_HOST}:${String(fixturePort)}/`,
		);
		try {
			// The mapping works and the fixture answers, so a refusal below is
			// the gate and not the network.
			const health = await page.evaluate(
				async ({
					host,
					port,
				}: {
					host: string;
					port: number;
				}): Promise<number> => {
					const response = await fetch(`http://${host}:${String(port)}/health`);
					return response.status;
				},
				{ host: FOREIGN_HOST, port: fixturePort },
			);
			expect(health).toBe(200);
			if (transport === undefined) {
				throw new TypeError("transport did not start");
			}
			// The grant is the attack: this is the bearer the page could never
			// have read, handed to it to see whether knowledge is enough.
			const admitted = await fetchInPage(page, {
				bearer: transport.bearer,
				forgeOrigin: null,
			});
			expect(admitted.rejected).toBe(true);
			const wrong = await fetchInPage(page, {
				bearer: "wrong",
				forgeOrigin: null,
			});
			// Identically refused from the page's point of view: neither fetch
			// survived the preflight, so neither produced a status at all.
			expect(wrong.rejected).toBe(true);
		} finally {
			await page.close();
		}
	});

	it("does not let a page present the extension's origin", async () => {
		// Two halves, deliberately separated. The socket half proves what the
		// listener does with a presented origin; the page half proves the
		// forged value never reaches it. `Origin` is a forbidden header: the
		// browser sends its own, so the rejection below is the preflight never
		// passing, not the listener seeing the forgery and refusing it.
		const page = await openPage(
			`http://${FOREIGN_HOST}:${String(fixturePort)}/`,
		);
		try {
			if (transport === undefined) {
				throw new TypeError("transport did not start");
			}
			const daemonPort = transport.port;
			// Listener-level: a genuinely presented extension origin is
			// admitted, so the gate is not what stops the page.
			const presented = await fetch(
				`http://127.0.0.1:${String(daemonPort)}/pull`,
				{
					headers: {
						Origin: EXTENSION_ORIGIN,
						"x-ax-bearer": transport.bearer,
					},
				},
			);
			expect(presented.status).toBe(204);
			await presented.text().catch(() => {});
			// Listener-level: a foreign origin with the same bearer is refused.
			const foreign = await fetch(
				`http://127.0.0.1:${String(daemonPort)}/pull`,
				{
					headers: {
						Origin: `http://${FOREIGN_HOST}:${String(fixturePort)}`,
						"x-ax-bearer": transport.bearer,
					},
				},
			);
			expect(foreign.status).toBe(403);
			await foreign.text().catch(() => {});
			const outcome = await fetchInPage(page, {
				bearer: transport.bearer,
				forgeOrigin: EXTENSION_ORIGIN,
			});
			expect(outcome.rejected).toBe(true);
			// Browser-level: the forged value never left the page.
			const seen = await page.evaluate(async (forged: string) => {
				const response = await fetch("/echo-origin", {
					method: "POST",
					headers: { Origin: forged },
				});
				return await response.text();
			}, EXTENSION_ORIGIN);
			expect(seen).not.toBe(EXTENSION_ORIGIN);
		} finally {
			await page.close();
		}
	});
});
