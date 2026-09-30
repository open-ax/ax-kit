// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation-library to input-schema conversion.
 *
 * Everything here is ours, not draft-derived: the draft defines the input
 * schema shape, while this module converts author-written schemas into it.
 * The core stays dependency-free; the validation library arrives only here.
 * Conversion flows through the library's first-party JSON-Schema output
 * with registry metadata carried into the result, then enforces the same
 * subset discipline the core validates: dangerous keys rejected at any
 * depth, unexpected properties governed by the declared policy, and
 * depth, key-count, and size caps enforced with stringify at the boundary.
 */

export const MAX_CONVERT_DEPTH = 10;
export const MAX_CONVERT_KEYS = 500;
export const MAX_CONVERT_BYTES = 65_536;

export interface ConvertOptions {
	readonly allowAdditionalProperties?: boolean | undefined;
}

const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

const KNOWN_TYPES: ReadonlySet<string> = new Set([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);

const SCANNED_KEYWORDS: ReadonlySet<string> = new Set([
	"type",
	"properties",
	"required",
	"items",
	"enum",
	"additionalProperties",
	"description",
	"title",
]);

interface WalkState {
	keys: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function checkKeys(node: Record<string, unknown>, state: WalkState): void {
	for (const key of Object.keys(node)) {
		if (DANGEROUS_KEYS.has(key)) {
			throw new TypeError(`forbidden key: ${key}`);
		}
	}
	state.keys += Object.keys(node).length;
	if (state.keys > MAX_CONVERT_KEYS) {
		throw new TypeError("too many keys");
	}
}

function checkJsonValue(
	value: unknown,
	depth: number,
	state: WalkState,
	seen: Set<object>,
): void {
	if (value === null) {
		return;
	}
	const kind: string = typeof value;
	if (kind === "string" || kind === "boolean") {
		return;
	}
	if (kind === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("non-finite number");
		}
		return;
	}
	if (Array.isArray(value) || isRecord(value)) {
		if (depth > MAX_CONVERT_DEPTH) {
			throw new TypeError("too deep");
		}
		if (seen.has(value)) {
			throw new TypeError("circular schema");
		}
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				for (const entry of value) {
					checkJsonValue(entry, depth + 1, state, seen);
				}
			} else {
				checkKeys(value, state);
				for (const entry of Object.values(value)) {
					checkJsonValue(entry, depth + 1, state, seen);
				}
			}
		} finally {
			seen.delete(value);
		}
		return;
	}
	throw new TypeError("non-JSON value");
}

function checkSchemaNode(
	node: unknown,
	depth: number,
	state: WalkState,
	seen: Set<object>,
	allowAdditional: boolean,
): void {
	if (!isRecord(node)) {
		throw new TypeError("schema not an object");
	}
	if (depth > MAX_CONVERT_DEPTH) {
		throw new TypeError("too deep");
	}
	if (seen.has(node)) {
		throw new TypeError("circular schema");
	}
	seen.add(node);
	try {
		checkKeys(node, state);
		for (const key of Object.keys(node)) {
			if (!SCANNED_KEYWORDS.has(key) && allowAdditional !== true) {
				throw new TypeError(`unexpected property: ${key}`);
			}
		}
		const nodeType: unknown = node.type;
		if (nodeType !== undefined) {
			if (typeof nodeType !== "string" || !KNOWN_TYPES.has(nodeType)) {
				throw new TypeError("unsupported type");
			}
		}
		const properties: unknown = node.properties;
		if (properties !== undefined) {
			if (!isRecord(properties)) {
				throw new TypeError("bad properties");
			}
			checkKeys(properties, state);
			for (const child of Object.values(properties)) {
				checkSchemaNode(child, depth + 1, state, seen, allowAdditional);
			}
		}
		const required: unknown = node.required;
		if (required !== undefined) {
			if (
				!Array.isArray(required) ||
				required.some((entry) => typeof entry !== "string")
			) {
				throw new TypeError("bad required");
			}
		}
		const items: unknown = node.items;
		if (items !== undefined) {
			checkSchemaNode(items, depth + 1, state, seen, allowAdditional);
		}
		const enumValues: unknown = node.enum;
		if (enumValues !== undefined) {
			if (!Array.isArray(enumValues)) {
				throw new TypeError("bad enum");
			}
			for (const entry of enumValues) {
				checkJsonValue(entry, depth + 1, state, seen);
			}
		}
		const additional: unknown = node.additionalProperties;
		if (additional !== undefined && typeof additional !== "boolean") {
			throw new TypeError("bad additionalProperties");
		}
		for (const key of ["description", "title"] as const) {
			const hint: unknown = node[key];
			if (hint !== undefined && typeof hint !== "string") {
				throw new TypeError(`bad ${key}`);
			}
		}
		for (const [key, child] of Object.entries(node)) {
			if (!SCANNED_KEYWORDS.has(key)) {
				checkJsonValue(child, depth + 1, state, seen);
			}
		}
	} finally {
		seen.delete(node);
	}
}

export interface LibrarySchemaLike {
	readonly toJSONSchema?: unknown;
	readonly jsonSchema?: unknown;
	readonly schema?: unknown;
}

/**
 * Extract the raw JSON-Schema document from a library schema. Supports the
 * first-party conversion (`toJSONSchema(options)`) and plain schema objects.
 * Input mode is selected so tool arguments reflect the validator's input.
 */
export function extractJsonSchema(
	schema: unknown,
	io: "input" | "output" = "input",
	target?: string | undefined,
): Record<string, unknown> {
	if (typeof schema !== "object" || schema === null) {
		throw new TypeError("bad library schema");
	}
	const record = schema as Record<string, unknown>;
	const converter = record.toJSONSchema;
	if (typeof converter === "function") {
		const args: Record<string, unknown> = { io };
		if (target !== undefined) {
			args.target = target;
		}
		const produced: unknown = (
			converter as (options?: unknown) => unknown
		).call(schema, args);
		if (
			typeof produced !== "object" ||
			produced === null ||
			Array.isArray(produced)
		) {
			throw new TypeError("converter produced no schema");
		}
		return produced as Record<string, unknown>;
	}
	if (isRecord(record.jsonSchema)) {
		return record.jsonSchema;
	}
	if (isRecord(record.schema)) {
		return record.schema;
	}
	if (isRecord(schema) && typeof record.type === "string") {
		return schema as Record<string, unknown>;
	}
	throw new TypeError("unsupported library schema");
}

/**
 * Convert a library schema to the specified input-schema shape. Emits the
 * JSON-Schema-subset object and stringifies at the boundary; serializer
 * errors propagate as `TypeError`. Conversion selects the library's
 * input representation so coerced and piped schemas advertise arguments.
 */
export function convertToInputSchema(
	schema: unknown,
	options?: ConvertOptions | undefined,
): Record<string, unknown> {
	return convertWithIo(schema, "input", undefined, options);
}

function convertWithIo(
	schema: unknown,
	io: "input" | "output",
	target: string | undefined,
	options: ConvertOptions | undefined,
): Record<string, unknown> {
	const raw = extractJsonSchema(schema, io, target);
	const allowAdditional = options?.allowAdditionalProperties === true;
	const envelope: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "$schema") {
			continue;
		}
		envelope[key] = value;
	}
	checkSchemaNode(envelope, 0, { keys: 0 }, new Set(), allowAdditional);
	let json: string;
	try {
		const text: unknown = JSON.stringify(envelope);
		if (typeof text !== "string") {
			throw new TypeError("unserializable schema");
		}
		json = text;
	} catch (error: unknown) {
		if (error instanceof TypeError) {
			throw error;
		}
		throw new TypeError("serializer error");
	}
	if (new TextEncoder().encode(json).length > MAX_CONVERT_BYTES) {
		throw new TypeError("schema too large");
	}
	return JSON.parse(json) as Record<string, unknown>;
}

const SUPPORTED_TARGETS: ReadonlySet<string> = new Set([
	"draft-2020-12",
	"draft-07",
	"draft-7",
	"draft-04",
	"draft-4",
	"openapi-3.0",
]);

function readTarget(options: unknown): string | undefined {
	if (options === undefined) {
		return undefined;
	}
	if (typeof options !== "object" || options === null) {
		throw new TypeError("bad converter options");
	}
	const target = (options as Record<string, unknown>).target;
	if (target === undefined) {
		return undefined;
	}
	if (typeof target !== "string" || !SUPPORTED_TARGETS.has(target)) {
		throw new TypeError(`unsupported target: ${String(target)}`);
	}
	return target;
}

/** Standard JSON-Schema converter shape, exposed alongside raw emission. */
export interface StandardJsonSchemaConverter {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly jsonSchema: {
			readonly input: (options?: unknown) => Record<string, unknown>;
			readonly output: (options?: unknown) => Record<string, unknown>;
		};
	};
	readonly jsonSchema: {
		readonly input: (options?: unknown) => Record<string, unknown>;
		readonly output: (options?: unknown) => Record<string, unknown>;
	};
}

export function asStandardConverter(
	schema: unknown,
	options?: ConvertOptions | undefined,
): StandardJsonSchemaConverter {
	const input = (converterOptions?: unknown): Record<string, unknown> =>
		convertWithIo(schema, "input", readTarget(converterOptions), options);
	const output = (converterOptions?: unknown): Record<string, unknown> =>
		convertWithIo(schema, "output", readTarget(converterOptions), options);
	const methods = { input, output };
	return {
		"~standard": { version: 1, vendor: "zod", jsonSchema: methods },
		jsonSchema: methods,
	};
}
