import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Two of these tests drive `auditLiveUrl`, which launches a real browser
		// and a real context *inside the test body* rather than reusing the one
		// `beforeAll` opened. That chain is bounded by process start-up, not by
		// anything this suite controls, and it runs while six other packages are
		// starting browsers of their own. Vitest's default 5s per-test budget is
		// not a statement about how long the work takes; it is just shorter than
		// a cold Chromium launch under load. The budget is raised rather than the
		// assertions loosened or the wait padded with a sleep.
		testTimeout: 30_000,
		hookTimeout: 180_000,
	},
});
