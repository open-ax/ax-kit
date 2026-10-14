// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a bridge reply.
 *
 * This function is the only place the daemon decides what a page's reply
 * *means*, and the case below is the one the draft owns. It is pinned here
 * because the failure it guards is silent: the wrong reading refuses successful
 * calls, and a refusal looks exactly like a page that refused to cooperate.
 */

import { describe, expect, it } from "vitest";

import { readToolOutcome, refusalFrom } from "../src/outcome.js";

describe("readToolOutcome", () => {
	it("reads a completed call, which the draft sends as a JSON string", () => {
		// `ModelContext.executeTool()` returns `USVString`. A reader that
		// required a record refused every tool that actually worked.
		const outcome = readToolOutcome('{"items":3}');
		expect(outcome).toEqual({ kind: "completed", result: '{"items":3}' });
	});

	it("forwards the page's value without parsing it", () => {
		// Not this process's business whether the page's JSON is well formed.
		// The value belongs to the page, and a client is the one that asked.
		expect(readToolOutcome("not json at all")).toEqual({
			kind: "completed",
			result: "not json at all",
		});
	});

	it("reads an approval as the question a person has to answer", () => {
		expect(
			readToolOutcome({
				requiresConfirmation: true,
				toolName: "transferFunds",
				description: "Send 20 GBP",
				argsJson: '{"to":"GB33"}',
				origin: "https://bank.test",
				frameOrigin: "https://bank.test",
				pendingApproval: "binding-1",
			}),
		).toEqual({
			kind: "approval-required",
			toolName: "transferFunds",
			description: "Send 20 GBP",
			argsJson: '{"to":"GB33"}',
			origin: "https://bank.test",
			frameOrigin: "https://bank.test",
			binding: "binding-1",
		});
	});

	it("refuses a confirmation flag the Trusted tier cannot have produced", () => {
		// Reading `requiresConfirmation: false` as a result would execute the
		// branch that files a card, with a body the person was never shown.
		expect(() =>
			readToolOutcome({
				requiresConfirmation: false,
				toolName: "transferFunds",
			}),
		).toThrow(TypeError);
	});

	it("refuses a shape that is neither", () => {
		// A record that is not a confirmation is not a result either. Falling
		// through to "completed" is how a call reports work that never ran.
		expect(() => readToolOutcome({ items: 3 })).toThrow(TypeError);
		expect(() => readToolOutcome(null)).toThrow(TypeError);
		expect(() => readToolOutcome(42)).toThrow(TypeError);
		expect(() => readToolOutcome([{ items: 3 }])).toThrow(TypeError);
	});
});

describe("refusalFrom", () => {
	it("keeps a code the extension chose, so a client can tell refusals apart", () => {
		const error = Object.assign(new Error("the page refused"), {
			code: -32001,
		});
		expect(refusalFrom(error, -32600)).toEqual({
			kind: "refused",
			code: -32001,
			message: "the page refused",
		});
	});

	it("falls back rather than surfacing a non-numeric code", () => {
		const error = Object.assign(new Error("odd"), { code: "nope" });
		expect(refusalFrom(error, -32600)).toEqual({
			kind: "refused",
			code: -32600,
			message: "odd",
		});
	});

	it("answers a non-Error rather than throwing", () => {
		expect(refusalFrom("a string", -32600)).toEqual({
			kind: "refused",
			code: -32600,
			message: "request failed",
		});
	});
});
