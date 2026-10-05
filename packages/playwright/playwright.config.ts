import { defineConfig } from "@playwright/test";

// Two sets of tests, deliberately separate.
//
// The fast set runs on one browser and is part of `pnpm test`. The suite set
// runs the proposal's own suite against the built bundle on every browser this
// project claims results for; it takes minutes rather than seconds and needs
// all three engines installed, so it is its own command. It is not disabled by
// default, it is simply not free.
const CONFORMANCE = /conformance-suite\.spec\.ts/;

export default defineConfig({
	testDir: "./test",
	timeout: 30_000,
	use: {},
	projects: [
		{
			name: "chromium",
			testIgnore: CONFORMANCE,
			use: { browserName: "chromium" },
		},
		{
			name: "conformance-chromium",
			testMatch: CONFORMANCE,
			use: { browserName: "chromium" },
		},
		{
			name: "conformance-firefox",
			testMatch: CONFORMANCE,
			use: { browserName: "firefox" },
		},
		{
			name: "conformance-webkit",
			testMatch: CONFORMANCE,
			use: { browserName: "webkit" },
		},
	],
});
