import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The end-to-end suite spawns a process and drives a real browser in
		// `beforeAll`. The default 5s per-test budget is fine for the unit
		// suites and too tight for a chain that crosses four real processes, so
		// the budget is raised rather than the assertions loosened.
		testTimeout: 30_000,
		hookTimeout: 180_000,
	},
});
