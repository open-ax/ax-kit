// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Rejection taxonomy, mirrored exactly from the pinned draft (spec.md D7,
 * D12). `TypeError` is a JavaScript error, not a `DOMException`; every other
 * family below is a `DOMException` with the specified name. Callers observe
 * the name, never a generic error.
 */

export function invalidState(message: string): DOMException {
	return new DOMException(message, "InvalidStateError");
}

export function securityError(message: string): DOMException {
	return new DOMException(message, "SecurityError");
}

export function notAllowed(message: string): DOMException {
	return new DOMException(message, "NotAllowedError");
}

export function notSupported(message: string): DOMException {
	return new DOMException(message, "NotSupportedError");
}

export function unknownError(message: string): DOMException {
	return new DOMException(message, "UnknownError");
}
