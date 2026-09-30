// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Byte-clean stdio transport: only protocol messages reach stdout, all
 * diagnostics go to stderr, frames are newline-delimited with no embedded
 * newlines, and stdin close is the portable shutdown signal.
 */

export const MAX_FRAME_BYTES: number = 1024 * 1024;

export function assertStdoutClean(text: string): void {
	if (text.includes("\n") && text.trim() !== text.trimEnd()) {
		throw new TypeError("stdout must carry one frame per line");
	}
	for (const line of text.split("\n")) {
		if (line === "") {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			throw new TypeError("non-protocol bytes on stdout");
		}
		if (typeof parsed !== "object" || parsed === null) {
			throw new TypeError("non-protocol bytes on stdout");
		}
	}
}

/** Split buffered stdin bytes into complete lines, keeping the remainder. */
export function splitFrames(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() as string;
	const lines = parts.map((line) => line.replace(/\r$/, ""));
	return { lines, rest };
}

/** True when the stdin side closed: the only portable shutdown signal. */
export function isStdinClosed(chunk: unknown): boolean {
	return chunk === null || chunk === undefined;
}

/** Write diagnostics to stderr only; never to stdout. */
export function logToStderr(
	write: (text: string) => void,
	message: string,
): void {
	write(`${message}\n`);
}
