// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readAttachment, readRefusal, serveRelay } from "../src/relay.js";

/**
 * The relay is the link that did not exist, so its tests are about the two
 * things that can go wrong at it: reading something that is not an attachment,
 * and driving a loop over a transport that does not behave.
 *
 * The loop is driven with a fake `fetch` rather than a real listener, because
 * the behaviour under test is what the loop does with a status code — and a
 * real listener would make every case that matters wait on a socket instead.
 */

const ATTACHMENT = { port: 43219, token: "0123456789abcdef0123" };

describe("attachment", () => {
	it("accepts a broker reply that carries a port and a bearer", () => {
		expect(
			readAttachment({ ok: true, port: 43219, token: "0123456789abcdef0123" }),
		).toEqual(ATTACHMENT);
	});

	it("refuses anything that is not one", () => {
		// A host process is not a trusted source. Every one of these is a shape
		// that would otherwise produce a fetch to somewhere unexpected, or to
		// somewhere with a bearer the caller made up.
		for (const value of [
			null,
			"43219",
			[],
			{ ok: false, reason: "no daemon is running" },
			{ ok: "true", port: 1, token: "0123456789abcdef0123" },
			{ ok: true, port: 0, token: "0123456789abcdef0123" },
			{ ok: true, port: 70000, token: "0123456789abcdef0123" },
			{ ok: true, port: 1.5, token: "0123456789abcdef0123" },
			{ ok: true, port: 43219 },
			{ ok: true, port: 43219, token: "short" },
			{ ok: true, port: 43219, token: 12345 },
		]) {
			expect(readAttachment(value), JSON.stringify(value)).toBeNull();
		}
	});

	it("reports the broker's own words when there is no daemon", () => {
		expect(readRefusal({ ok: false, reason: "no daemon is running" })).toBe(
			"no daemon is running",
		);
		// A refusal with no reason is still a refusal, and a person reading it
		// should be told something rather than shown an empty panel.
		expect(readRefusal({ ok: false })).toMatch(/refused/);
		expect(readRefusal(null)).toMatch(/refused/);
	});
});

describe("relay loop", () => {
	it("asks, executes, answers, and asks again", async () => {
		const seen: string[] = [];
		let pulled = 0;
		const stops: string[] = [];
		const fake = (async (url: string, init?: RequestInit) => {
			const path = String(url);
			seen.push(`${init?.method ?? "GET"} ${path}`);
			if (path.endsWith("/pull")) {
				pulled += 1;
				// Two envelopes, then a stop: the loop's job is to keep going
				// until the transport ends, not to stop at the first result.
				if (pulled === 1) {
					return json({
						id: 1,
						request: { handler: "activeTab", args: {} },
					});
				}
				if (pulled === 2) {
					return json({
						id: 2,
						request: { handler: "listTools", args: { tabId: 7 } },
					});
				}
				throw new Error("daemon went away");
			}
			return json({ ok: true });
		}) as unknown as typeof fetch;

		await serveRelay(
			ATTACHMENT,
			async (request) => {
				return { handler: request.handler };
			},
			(stop) => {
				stops.push(stop.kind);
			},
			fake,
		);

		expect(stops).toEqual(["unreachable"]);
		expect(seen[0]).toBe(`GET http://127.0.0.1:43219/pull`);
		// The result goes back before the next pull, or a call would be answered
		// twice or not at all.
		expect(seen[1]).toBe("POST http://127.0.0.1:43219/result");
		expect(seen[2]).toBe("GET http://127.0.0.1:43219/pull");
	});

	it("re-asks on an empty queue instead of treating it as the end", async () => {
		let pulled = 0;
		const fake = (async (url: string) => {
			if (String(url).endsWith("/pull")) {
				pulled += 1;
				// The daemon holds the request and answers 204 when the hold
				// expires with nothing queued. That is idle, not shutdown: a loop
				// that returned here would serve exactly one request per daemon
				// restart.
				if (pulled < 3) {
					return new Response(null, { status: 204 });
				}
				throw new Error("done");
			}
			return json({ ok: true });
		}) as unknown as typeof fetch;

		await serveRelay(
			ATTACHMENT,
			async () => ({}),
			() => {},
			fake,
		);
		expect(pulled).toBe(3);
	});

	it("answers a refused call as a JSON-RPC error rather than dropping it", async () => {
		const posted: string[] = [];
		let pulled = 0;
		const fake = (async (url: string, init?: RequestInit) => {
			if (String(url).endsWith("/pull")) {
				pulled += 1;
				if (pulled === 1) {
					return json({
						id: 9,
						request: { handler: "executeTool", args: { name: "payNow" } },
					});
				}
				throw new Error("done");
			}
			posted.push(String(init?.body));
			return json({ ok: true });
		}) as unknown as typeof fetch;

		await serveRelay(
			ATTACHMENT,
			async () => {
				throw new TypeError("tool not found: payNow");
			},
			() => {},
			fake,
		);

		expect(posted).toHaveLength(1);
		const frame = JSON.parse(posted[0]) as Record<string, unknown>;
		expect(frame.id).toBe(9);
		expect(frame.result).toBeUndefined();
		expect((frame.error as Record<string, unknown>).message).toMatch(
			/tool not found/,
		);
	});

	it("stops rather than spinning when the daemon answers a status it cannot use", async () => {
		const stops: string[] = [];
		const fake = (async () =>
			json({ ok: false }, 403)) as unknown as typeof fetch;
		await serveRelay(
			ATTACHMENT,
			async () => ({}),
			(stop) => {
				stops.push(stop.kind);
			},
			fake,
		);
		expect(stops).toEqual(["unreachable"]);
	});
});

/** A minimal JSON response, so the fake `fetch` needs no framework. */
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
