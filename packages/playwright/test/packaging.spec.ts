// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "../src/fixture.js";

function packageJson(): Record<string, unknown> {
	return JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as Record<string, unknown>;
}

function entrySource(): string {
	return readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
}

function readme(): string {
	return readFileSync(new URL("../README.md", import.meta.url), "utf8");
}

function changelog(): string {
	return readFileSync(
		new URL("../../../CHANGELOG.md", import.meta.url),
		"utf8",
	);
}

test("pins the runner floor and excludes component entries", () => {
	const manifest = packageJson();
	const peer = manifest.peerDependencies as Record<string, string>;
	expect(peer["@playwright/test"]).toBe("^1.63.0");
	const dev = manifest.devDependencies as Record<string, string>;
	expect(dev["@playwright/test"]).toBe("1.63.0");
	expect(dev.playwright).toBe("1.63.0");
	for (const name of [...Object.keys(peer), ...Object.keys(dev)]) {
		expect(name).not.toContain("ct-");
		expect(name).not.toContain("component");
	}
	expect(manifest.files).toEqual(["dist"]);
});

test("keeps the test-only harness out of the published entry", () => {
	expect(entrySource()).not.toContain("shuffl");
	const srcFiles = readdirSync(new URL("../src/", import.meta.url));
	for (const file of srcFiles) {
		expect(file.toLowerCase()).not.toContain("shuffl");
		expect(file.toLowerCase()).not.toContain("chaos");
	}
});

test("records user-visible behavior with its draft date", () => {
	const docs = readme();
	expect(docs).toContain("26 September 2026");
	for (const name of [
		"waitForTool",
		"expectTool",
		"getAvailableTools",
		"executeTool",
	]) {
		expect(docs).toContain(name);
	}
	expect(docs).not.toContain("chaos");
	const log = changelog();
	expect(log).toContain("@ax-kit/playwright");
	expect(log).toContain("26 September 2026");
});
