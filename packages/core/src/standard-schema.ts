// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { assertValidArguments } from "./schema.js";

/**
 * Structural mirror of the Standard Schema `StandardSchemaV1` shape
 * (`@standard-schema/spec@1.1.0`, verified 2026-09-27). Declared locally and
 * consumed structurally: this package never installs a validation library.
 * Only the `validate` subset we actually use is mirrored; anything else is out
 * of scope for the polyfill.
 */
export interface StandardIssue {
	readonly message: string;
	readonly path?: ReadonlyArray<PropertyKey> | undefined;
}

export interface StandardResult {
	readonly value?: unknown;
	readonly issues?: ReadonlyArray<StandardIssue> | undefined;
}

export interface StandardSchema {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (
			value: unknown,
		) => StandardResult | Promise<StandardResult>;
	};
}

/**
 * Expose argument validation through the mirrored Standard Schema shape, so a
 * later consumer (daemon, adapter) can drive it without depending on one.
 * Ours, not draft-derived.
 */
export function asStandardSchema(
	storedSchema: string | undefined,
): StandardSchema {
	return {
		"~standard": {
			version: 1,
			vendor: "ax-kit",
			validate: (value: unknown): StandardResult => {
				try {
					assertValidArguments(value, storedSchema);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "invalid value";
					return { issues: [{ message }] };
				}
				return { value };
			},
		},
	};
}
