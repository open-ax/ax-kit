// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(name: string): string {
	return readFileSync(join(process.cwd(), "src", name), "utf8");
}

describe("negative guards", () => {
	it("registers in the client mount hook only", () => {
		const composable = src("composable.ts");
		expect(composable).toMatch("onMounted");
		expect(composable).toMatch("onUnmounted");
		expect(composable).not.toMatch("setTimeout");
		expect(composable).not.toMatch("setInterval");
	});

	it("keeps directive state off binding arguments", () => {
		const directive = src("directive.ts");
		expect(directive).toMatch("WeakMap");
		expect(directive).toMatch("getSSRProps");
	});

	it("declares zero runtime dependencies", () => {
		const pkg = JSON.parse(
			readFileSync(join(process.cwd(), "package.json"), "utf8"),
		) as unknown as { dependencies?: unknown };
		expect(pkg.dependencies).toBeUndefined();
	});
});
