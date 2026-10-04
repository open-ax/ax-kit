// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { SPEC_VERSION } from "../src/index.js";

describe("SPEC_VERSION", () => {
	it("pins the draft the package implements", () => {
		expect(SPEC_VERSION.draft).toBe(
			"Draft Community Group Report, 2 October 2026",
		);
		expect(SPEC_VERSION.commit).toBe("d61d0e6");
	});
});
