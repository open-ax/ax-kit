import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "dom",
					environment: "happy-dom",
					include: ["test/*.test.ts"],
				},
			},
			{
				test: {
					name: "chromium",
					include: ["test/browser/*.test.ts"],
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
});
