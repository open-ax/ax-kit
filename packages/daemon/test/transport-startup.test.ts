// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTransport } from "../src/lifecycle.js";

/**
 * The listener must be able to fail without taking the process with it.
 *
 * `main.ts` documents that a transport which cannot be opened is "a warning
 * rather than a refusal to start", and wraps `startTransport` so the rejection
 * degrades the daemon to stdio. That only holds if a failure inside the listen
 * callback arrives as a rejection.
 *
 * The callback runs after the promise executor has returned, so nothing in it is
 * inside the promise's own scope: before this was fixed, a discovery directory
 * that could not be created threw out of the callback as an uncaught exception,
 * the process exited with code 1, and the documented fallback never ran. A unit
 * test could not have found it - every unit test used a directory that could be
 * created. It was found by walking the setup as a person would.
 */
describe("startTransport", () => {
	const opened: Array<{ close: () => Promise<void> }> = [];

	afterEach(async () => {
		while (opened.length > 0) {
			await opened
				.pop()
				?.close()
				.catch(() => {
					// Teardown only. A close failure here is not what this file is about.
				});
		}
	});

	it("rejects when the discovery directory cannot be created", async () => {
		const root = mkdtempSync(join(tmpdir(), "ax-kit-discovery-"));
		// A regular file where a directory is needed: `mkdir` under it fails with
		// ENOTDIR on every platform this repository runs on, and it fails *after*
		// the socket is already listening, which is the placement that used to
		// escape as an uncaught throw.
		const blocker = join(root, "not-a-dir");
		writeFileSync(blocker, "", "utf8");

		await expect(
			startTransport({ discoveryDir: join(blocker, "sub") }),
		).rejects.toThrow();
	});

	it("resolves with the bound port and writes its discovery file", async () => {
		// The success path, so the rejection above is not the only thing this file
		// proves: a fix that turned every failure into a rejection without ever
		// resolving would still pass the first test.
		const root = mkdtempSync(join(tmpdir(), "ax-kit-discovery-"));
		const openedHere = await startTransport({ discoveryDir: root });
		opened.push(openedHere);

		expect(openedHere.port).toBeGreaterThan(0);
		expect(openedHere.discoveryPath.startsWith(root)).toBe(true);
	});
});
