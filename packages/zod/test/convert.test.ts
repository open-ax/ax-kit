// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	asStandardConverter,
	convertToInputSchema,
	extractJsonSchema,
} from "../src/convert.js";

describe("validation-library adapter", () => {
	it("converts primitives, nesting, enums, and required", () => {
		const schema = z.object({
			query: z.string(),
			maxPrice: z.number().optional(),
			tag: z.enum(["a", "b"]),
		});
		const converted = convertToInputSchema({
			toJSONSchema: () => z.toJSONSchema(schema),
		});
		expect(typeof converted.type).toBe("string");
		expect(extractJsonSchema({ type: "object" }).type).toBe("object");
	});

	it("passes registry metadata through the first-party conversion", () => {
		const schema = z
			.string()
			.meta({ title: "Query", description: "Search text." });
		const converted = convertToInputSchema({
			toJSONSchema: () => z.toJSONSchema(schema),
		});
		expect(
			converted.title ?? converted.description ?? converted.type,
		).toBeDefined();
	});

	it("rejects dangerous keys at depth", () => {
		expect(() =>
			convertToInputSchema({
				type: "object",
				properties: { ["__proto__"]: { type: "string" } },
			}),
		).toThrow(TypeError);
		expect(() =>
			convertToInputSchema({ type: "object", constructor: { type: "string" } }),
		).toThrow(TypeError);
	});

	it("governs unexpected properties by policy", () => {
		const raw = { type: "string", format: "email" };
		expect(() => convertToInputSchema(raw)).toThrow(TypeError);
		expect(
			convertToInputSchema(raw, { allowAdditionalProperties: true }).type,
		).toBe("string");
	});

	it("caps depth, keys, and size with boundary stringify", () => {
		let deep: Record<string, unknown> = { type: "string" };
		for (let index = 0; index < 12; index += 1) {
			deep = { type: "object", properties: { child: deep } };
		}
		expect(() => convertToInputSchema(deep)).toThrow(TypeError);
		const circular: Record<string, unknown> = { type: "object" };
		circular.self = circular;
		expect(() => convertToInputSchema(circular)).toThrow(TypeError);
		expect(() => convertToInputSchema(undefined)).toThrow(TypeError);
	});

	it("exposes the standard converter alongside raw emission", () => {
		const converter = asStandardConverter({ type: "string" });
		expect(converter.jsonSchema.input().type).toBe("string");
		expect(converter.jsonSchema.output().type).toBe("string");
	});

	it("validates types, required, and hint shapes at any depth", () => {
		expect(() => convertToInputSchema({ type: "eviltype" })).toThrow(TypeError);
		expect(() =>
			convertToInputSchema({ type: "object", required: "sku" }),
		).toThrow(TypeError);
		expect(() =>
			convertToInputSchema({ type: "string", description: { ["__proto__"]: 1 } }),
		).toThrow(TypeError);
	});

	it("isolates converter snapshots", () => {
		const converter = asStandardConverter({
			type: "object",
			properties: { a: { type: "string" } },
		});
		const first = converter.jsonSchema.input();
		(first.properties as Record<string, unknown>).a = { type: "eviltype" };
		expect(converter.jsonSchema.input()).not.toEqual(first);
	});
});
