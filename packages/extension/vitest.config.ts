import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Four of these files drive a real Chromium with a real unpacked
		// extension, and the assertions that matter cross a process boundary:
		// the service worker is asked, a panel page is opened and clicked, and
		// the invocation is only complete when the worker's side observes the
		// result. Each of those steps is bounded by another process's
		// scheduling, not by this suite, and they all happen while the rest of
		// the workspace is starting browsers of its own. The default 5s
		// per-test budget is shorter than that under load. It is raised rather
		// than the assertions loosened or the wait padded with a sleep.
		testTimeout: 30_000,
		hookTimeout: 180_000,
	},
});
