// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
	assertValidArguments,
	MAX_SCHEMA_BYTES,
	MAX_SCHEMA_DEPTH,
	MAX_SCHEMA_KEYS,
	parseInputSchema,
	serializeInputSchema,
} from "../src/schema.js";

function nestedObject(depth: number): unknown {
	let current: unknown = { type: "string" };
	for (let i = 0; i < depth; i += 1) {
		current = { type: "object", properties: { nested: current } };
	}
	return current;
}

describe("serializeInputSchema", () => {
	it("absent schema stays absent", () => {
		expect(serializeInputSchema(undefined)).toBeUndefined();
		expect(parseInputSchema(undefined)).toBeUndefined();
	});

	it("round-trips through a string with copy semantics", () => {
		const schema = {
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		};
		const stored = serializeInputSchema(schema);
		expect(typeof stored).toBe("string");
		schema.properties.q.type = "number";
		const parsed = parseInputSchema(stored) as typeof schema;
		expect(parsed.properties.q.type).toBe("string");
		parsed.properties.q.type = "boolean";
		expect((parseInputSchema(stored) as typeof schema).properties.q.type).toBe(
			"string",
		);
	});

	it("rejects values that stringify to undefined", () => {
		expect(() => serializeInputSchema(() => {})).toThrow(TypeError);
		expect(() => serializeInputSchema(Symbol("s"))).toThrow(TypeError);
	});

	it("rejects circular schemas", () => {
		const schema: Record<string, unknown> = { type: "object" };
		schema.self = schema;
		expect(() => serializeInputSchema(schema)).toThrow(TypeError);
	});

	it("rejects non-JSON values inside the schema", () => {
		expect(() => serializeInputSchema({ type: 42 })).toThrow(TypeError);
		expect(() =>
			serializeInputSchema({ type: "object", properties: { f: BigInt(1) } }),
		).toThrow(TypeError);
	});

	it("rejects dangerous keys at any depth", () => {
		expect(() =>
			serializeInputSchema({ type: "object", __proto__: { x: 1 } }),
		).toThrow(TypeError);
		expect(() =>
			serializeInputSchema({
				type: "object",
				properties: { a: { type: "string", constructor: true } },
			}),
		).toThrow(TypeError);
		expect(() =>
			serializeInputSchema({
				type: "object",
				properties: { a: { type: "object", properties: { prototype: {} } } },
			}),
		).toThrow(TypeError);
	});

	it("rejects non-object schema documents", () => {
		expect(() => serializeInputSchema([1, 2])).toThrow(TypeError);
		expect(() => serializeInputSchema("string")).toThrow(TypeError);
		expect(() => serializeInputSchema(null)).toThrow(TypeError);
	});

	it("enforces the depth cap", () => {
		expect(() =>
			serializeInputSchema(nestedObject(MAX_SCHEMA_DEPTH + 1)),
		).toThrow(TypeError);
		expect(() =>
			serializeInputSchema(nestedObject(MAX_SCHEMA_DEPTH)),
		).not.toThrow();
	});

	it("enforces the key cap", () => {
		const properties: Record<string, unknown> = {};
		for (let i = 0; i < MAX_SCHEMA_KEYS + 1; i += 1) {
			properties[`p${i}`] = { type: "string" };
		}
		expect(() => serializeInputSchema({ type: "object", properties })).toThrow(
			TypeError,
		);
	});

	it("enforces the serialized-size cap", () => {
		const big = { type: "string", enum: ["x".repeat(MAX_SCHEMA_BYTES)] };
		expect(() => serializeInputSchema(big)).toThrow(TypeError);
	});

	it("rejects malformed known keywords", () => {
		expect(() =>
			serializeInputSchema({ type: "object", required: "q" }),
		).toThrow(TypeError);
		expect(() =>
			serializeInputSchema({ type: "object", properties: [] }),
		).toThrow(TypeError);
		expect(() =>
			serializeInputSchema({ type: "object", additionalProperties: {} }),
		).toThrow(TypeError);
	});

	it("ignores benign unknown keywords", () => {
		expect(() =>
			serializeInputSchema({ type: "string", description: "a name" }),
		).not.toThrow();
	});
	it("rejects dangerous keys inside unknown keywords", () => {
		const parsed = JSON.parse(
			'{"type":"object","anyOf":[{"__proto__":{}}]}',
		) as unknown;
		expect(() => serializeInputSchema(parsed)).toThrow(TypeError);
		expect(() =>
			serializeInputSchema({ type: "string", anyOf: [{ type: "number" }] }),
		).not.toThrow();
	});
});

describe("assertValidArguments", () => {
	it("requires an object at the boundary", () => {
		expect(() => assertValidArguments("nope", undefined)).toThrow(TypeError);
		expect(() => assertValidArguments(null, undefined)).toThrow(TypeError);
		expect(() => assertValidArguments(42, undefined)).toThrow(TypeError);
		expect(() => assertValidArguments({ a: 1 }, undefined)).not.toThrow();
	});

	it("validates primitives, required, and enum", () => {
		const stored = serializeInputSchema({
			type: "object",
			properties: {
				q: { type: "string" },
				n: { type: "number" },
				mode: { enum: ["a", "b"] },
			},
			required: ["q"],
		});
		expect(() =>
			assertValidArguments({ q: "x", n: 1, mode: "a" }, stored),
		).not.toThrow();
		expect(() => assertValidArguments({ n: 1 }, stored)).toThrow(TypeError);
		expect(() => assertValidArguments({ q: 1 }, stored)).toThrow(TypeError);
		expect(() => assertValidArguments({ q: "x", mode: "z" }, stored)).toThrow(
			TypeError,
		);
	});

	it("validates integer, boolean, null, nested objects, and arrays", () => {
		const stored = serializeInputSchema({
			type: "object",
			properties: {
				count: { type: "integer" },
				flag: { type: "boolean" },
				nothing: { type: "null" },
				address: { type: "object", properties: { city: { type: "string" } } },
				tags: { type: "array", items: { type: "string" } },
			},
		});
		expect(() =>
			assertValidArguments(
				{
					count: 3,
					flag: false,
					nothing: null,
					address: { city: "Riga" },
					tags: ["a", "b"],
				},
				stored,
			),
		).not.toThrow();
		expect(() => assertValidArguments({ count: 3.5 }, stored)).toThrow(
			TypeError,
		);
		expect(() => assertValidArguments({ tags: ["a", 1] }, stored)).toThrow(
			TypeError,
		);
		expect(() =>
			assertValidArguments({ address: { city: 7 } }, stored),
		).toThrow(TypeError);
	});

	it("enforces the additional-properties policy", () => {
		const closed = serializeInputSchema({
			type: "object",
			properties: { a: { type: "string" } },
			additionalProperties: false,
		});
		expect(() => assertValidArguments({ a: "x" }, closed)).not.toThrow();
		expect(() => assertValidArguments({ a: "x", b: "y" }, closed)).toThrow(
			TypeError,
		);
		const open = serializeInputSchema({
			type: "object",
			properties: { a: { type: "string" } },
		});
		expect(() => assertValidArguments({ a: "x", b: "y" }, open)).not.toThrow();
	});

	it("re-validates against the stored string, not a live object", () => {
		const schema = { type: "object", properties: { a: { type: "string" } } };
		const stored = serializeInputSchema(schema);
		schema.properties.a.type = "number";
		expect(() => assertValidArguments({ a: "x" }, stored)).not.toThrow();
		expect(() => assertValidArguments({ a: 1 }, stored)).toThrow(TypeError);
	});
});
