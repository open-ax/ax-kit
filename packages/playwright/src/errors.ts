// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed runner-side errors. Ours, not the draft's: the draft's families
 * travel inside the page, while these describe the runner boundary itself
 * so a missing installation never passes silently as a generic error.
 */
export class AxMissingSurfaceError extends Error {
	constructor() {
		super("typed surface is missing");
		this.name = "AxMissingSurfaceError";
	}
}

/**
 * Map a surface-absence failure crossing the evaluate boundary to the
 * typed error. In-page throws arrive as generic errors carrying our
 * message; callers observe the type, never the string.
 */
export async function withSurfaceError<T>(task: Promise<T>): Promise<T> {
	try {
		return await task;
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("typed surface is missing")
		) {
			throw new AxMissingSurfaceError();
		}
		throw error;
	}
}
