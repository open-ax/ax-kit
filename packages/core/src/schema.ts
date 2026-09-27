// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Restricted JSON Schema subset handling for tool input schemas.
 *
 * Everything in this file is ours, not draft-derived: the draft requires an
 * input schema but does not define how a polyfill validates it. The guards
 * here (dangerous keys, depth/key/size caps, the keyword subset) are our
 * design choices. See the decision log for why each exists.
 *
 * Storage discipline: a schema is serialized to a string at Registration and
 * re-parsed on every read, so no live caller object is ever retained and every
 * listing hands out a fresh deep copy (`undefined` when none was given).
 */

export const MAX_SCHEMA_DEPTH = 10;
export const MAX_SCHEMA_KEYS = 500;
export const MAX_SCHEMA_BYTES = 65_536;

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
			throw new TypeError(`input schema uses a forbidden key: ${key}`);
		}
	}
	state.keys += Object.keys(node).length;
	if (state.keys > MAX_SCHEMA_KEYS) {
		throw new TypeError("input schema exceeds the key limit");
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
			throw new TypeError("input schema holds a non-finite number");
		}
		return;
	}
	if (Array.isArray(value)) {
		if (depth > MAX_SCHEMA_DEPTH) {
			throw new TypeError("input schema exceeds the depth limit");
		}
		if (seen.has(value)) {
			throw new TypeError("input schema is circular");
		}
		seen.add(value);
		for (const entry of value) {
			checkJsonValue(entry, depth + 1, state, seen);
		}
		seen.delete(value);
		return;
	}
	if (isRecord(value)) {
		if (depth > MAX_SCHEMA_DEPTH) {
			throw new TypeError("input schema exceeds the depth limit");
		}
		if (seen.has(value)) {
			throw new TypeError("input schema is circular");
		}
		seen.add(value);
		checkKeys(value, state);
		for (const entry of Object.values(value)) {
			checkJsonValue(entry, depth + 1, state, seen);
		}
		seen.delete(value);
		return;
	}
	throw new TypeError("input schema holds a non-JSON value");
}

function checkSchemaNode(
	node: unknown,
	depth: number,
	state: WalkState,
	seen: Set<object>,
): void {
	if (!isRecord(node)) {
		throw new TypeError("input schema must be an object");
	}
	if (depth > MAX_SCHEMA_DEPTH) {
		throw new TypeError("input schema exceeds the depth limit");
	}
	if (seen.has(node)) {
		throw new TypeError("input schema is circular");
	}
	seen.add(node);
	checkKeys(node, state);

	const nodeType: unknown = node.type;
	if (nodeType !== undefined) {
		if (typeof nodeType !== "string" || !KNOWN_TYPES.has(nodeType)) {
			seen.delete(node);
			throw new TypeError("input schema has an unsupported type");
		}
	}

	const properties: unknown = node.properties;
	if (properties !== undefined) {
		if (!isRecord(properties)) {
			seen.delete(node);
			throw new TypeError("input schema properties must be an object");
		}
		// Property names are keys in the document too: scan and count them.
		checkKeys(properties, state);
		for (const child of Object.values(properties)) {
			checkSchemaNode(child, depth + 1, state, seen);
		}
	}

	const required: unknown = node.required;
	if (required !== undefined) {
		if (
			!Array.isArray(required) ||
			required.some((entry) => typeof entry !== "string")
		) {
			seen.delete(node);
			throw new TypeError("input schema required must list strings");
		}
	}

	const items: unknown = node.items;
	if (items !== undefined) {
		checkSchemaNode(items, depth + 1, state, seen);
	}

	const enumValues: unknown = node.enum;
	if (enumValues !== undefined) {
		if (!Array.isArray(enumValues)) {
			seen.delete(node);
			throw new TypeError("input schema enum must be an array");
		}
		for (const entry of enumValues) {
			checkJsonValue(entry, depth + 1, state, seen);
		}
	}

	const additional: unknown = node.additionalProperties;
	if (additional !== undefined && typeof additional !== "boolean") {
		seen.delete(node);
		throw new TypeError("input schema additionalProperties must be a boolean");
	}

	for (const key of ["description", "title"] as const) {
		const hint: unknown = node[key];
		if (hint !== undefined && typeof hint !== "string") {
			seen.delete(node);
			throw new TypeError(`input schema ${key} must be a string`);
		}
	}

	seen.delete(node);
}

/**
 * Serialize a caller-supplied schema for storage. Returns `undefined` when no
 * schema was given. Throws `TypeError` for anything that cannot be stored
 * faithfully, and never returns a live reference.
 */
export function serializeInputSchema(schema: unknown): string | undefined {
	if (schema === undefined) {
		return undefined;
	}
	checkSchemaNode(schema, 0, { keys: 0 }, new Set());
	const json: unknown = JSON.stringify(schema);
	if (typeof json !== "string") {
		throw new TypeError("input schema cannot be serialized");
	}
	if (json.length > MAX_SCHEMA_BYTES) {
		throw new TypeError("input schema exceeds the size limit");
	}
	return json;
}

/**
 * Re-parse a stored schema into a fresh deep copy (`undefined` when none was
 * given). The stored string was produced by `serializeInputSchema`, so parsing
 * alone restores the copy semantics.
 */
export function parseInputSchema(stored: string | undefined): unknown {
	if (stored === undefined) {
		return undefined;
	}
	return JSON.parse(stored) as unknown;
}

function deepEqual(first: unknown, second: unknown): boolean {
	if (Object.is(first, second)) {
		return true;
	}
	if (
		typeof first !== "object" ||
		typeof second !== "object" ||
		first === null ||
		second === null
	) {
		return false;
	}
	if (Array.isArray(first) || Array.isArray(second)) {
		if (!Array.isArray(first) || !Array.isArray(second)) {
			return false;
		}
		if (first.length !== second.length) {
			return false;
		}
		return first.every((entry, index) => deepEqual(entry, second[index]));
	}
	const firstKeys = Object.keys(first);
	if (firstKeys.length !== Object.keys(second).length) {
		return false;
	}
	return firstKeys.every(
		(key) =>
			Object.hasOwn(second, key) &&
			deepEqual(
				Reflect.get(first, key) as unknown,
				Reflect.get(second, key) as unknown,
			),
	);
}

function checkValueType(value: unknown, expected: string, path: string): void {
	switch (expected) {
		case "object":
			if (!isRecord(value)) {
				throw new TypeError(`${path} must be an object`);
			}
			break;
		case "array":
			if (!Array.isArray(value)) {
				throw new TypeError(`${path} must be an array`);
			}
			break;
		case "string":
			if (typeof value !== "string") {
				throw new TypeError(`${path} must be a string`);
			}
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new TypeError(`${path} must be a number`);
			}
			break;
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) {
				throw new TypeError(`${path} must be an integer`);
			}
			break;
		case "boolean":
			if (typeof value !== "boolean") {
				throw new TypeError(`${path} must be a boolean`);
			}
			break;
		case "null":
			if (value !== null) {
				throw new TypeError(`${path} must be null`);
			}
			break;
		default:
			throw new TypeError(`${path} has an unsupported type`);
	}
}

function validateAgainstSchema(
	value: unknown,
	schema: Record<string, unknown>,
	path: string,
): void {
	const nodeType: unknown = schema.type;
	if (typeof nodeType === "string") {
		checkValueType(value, nodeType, path);
	}

	const enumValues: unknown = schema.enum;
	if (Array.isArray(enumValues)) {
		if (!enumValues.some((entry) => deepEqual(value, entry))) {
			throw new TypeError(`${path} is not an allowed value`);
		}
	}

	if (Array.isArray(value)) {
		const items: unknown = schema.items;
		if (isRecord(items)) {
			value.forEach((entry, index) => {
				validateAgainstSchema(entry, items, `${path}[${index}]`);
			});
		}
		return;
	}

	if (!isRecord(value)) {
		return;
	}

	const required: unknown = schema.required;
	if (Array.isArray(required)) {
		for (const name of required) {
			if (typeof name === "string" && !Object.hasOwn(value, name)) {
				throw new TypeError(`${path} is missing required property ${name}`);
			}
		}
	}

	const properties: unknown = schema.properties;
	const known: ReadonlySet<string> = isRecord(properties)
		? new Set(Object.keys(properties))
		: new Set<string>();
	if (isRecord(properties)) {
		for (const [name, child] of Object.entries(properties)) {
			if (Object.hasOwn(value, name) && isRecord(child)) {
				validateAgainstSchema(
					Reflect.get(value, name) as unknown,
					child,
					`${path}.${name}`,
				);
			}
		}
	}

	if (schema.additionalProperties === false) {
		for (const name of Object.keys(value)) {
			if (!known.has(name)) {
				throw new TypeError(`${path} has an unexpected property ${name}`);
			}
		}
	}
}

/**
 * Validate agent-supplied arguments against the stored schema. With no schema,
 * any object is accepted; non-objects always reject with `TypeError`. Every
 * mismatch against a stored schema also rejects with `TypeError` — the
 * specified error family for malformed calls.
 */
export function assertValidArguments(
	args: unknown,
	storedSchema: string | undefined,
): void {
	if (typeof args !== "object" || args === null) {
		throw new TypeError("tool arguments must be an object");
	}
	if (storedSchema === undefined) {
		return;
	}
	const schema: unknown = parseInputSchema(storedSchema);
	if (!isRecord(schema)) {
		throw new TypeError("stored input schema is not an object");
	}
	validateAgainstSchema(args, schema, "arguments");
}
