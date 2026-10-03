// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Byte-clean stdio transport: frames are newline-delimited with no embedded
 * newlines, and an oversized frame is refused rather than buffered.
 *
 * Only protocol messages reach stdout. That is a property of construction
 * rather than of a check: `createNodeSink` in the entry module holds the sole
 * `process.stdout.write`, and it wraps serialized frames. A function asserting
 * the property after the fact would be testing a caller that cannot violate it.
 */

export const MAX_FRAME_BYTES: number = 1024 * 1024;

/** Split buffered stdin bytes into complete lines, keeping the remainder. */
export function splitFrames(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts.map((line) => line.replace(/\r$/, ""));
	for (const frame of [...lines, rest]) {
		if (frame.length === 0) {
			continue;
		}
		if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
			throw new TypeError("frame too large");
		}
	}
	return { lines, rest };
}

/** Write diagnostics to stderr only; never to stdout. */
export function logToStderr(
	write: (text: string) => void,
	message: string,
): void {
	write(`${message}\n`);
}
