// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(name: string): string {
	return readFileSync(join(process.cwd(), "src", name), "utf8");
}

describe("negative guards", () => {
	it("uses one teardown mechanism per binding", () => {
		const action = src("action.ts");
		expect(action).toMatch("update");
		expect(action).toMatch("destroy");
		expect(action).not.toMatch("setTimeout");
		expect(action).not.toMatch("setInterval");
	});

	it("keeps an explicit guard in shared helper paths", () => {
		const action = src("action.ts");
		expect(action).toMatch("typeof window");
	});

	it("declares zero runtime dependencies", () => {
		const pkg = JSON.parse(
			readFileSync(join(process.cwd(), "package.json"), "utf8"),
		) as unknown as { dependencies?: unknown };
		expect(pkg.dependencies).toBeUndefined();
	});
});
