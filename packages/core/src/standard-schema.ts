// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural mirror of the Standard Schema `StandardSchemaV1` shape
 * (`@standard-schema/spec@1.1.0`). Declared locally so a deferred consumer
 * can drive validation structurally: this package never installs a validation
 * library. Only the `validate` subset is mirrored; anything else is out of
 * scope for the polyfill.
 */
export interface StandardPathSegment {
	readonly key: PropertyKey;
}

export interface StandardIssue {
	readonly message: string;
	readonly path?: ReadonlyArray<PropertyKey | StandardPathSegment> | undefined;
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
