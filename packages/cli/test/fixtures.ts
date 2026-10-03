// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixture pages for the audit: one per finding class, each a real page that
 * installs the shipped core exactly the way a consumer would.
 *
 * Everything is ours, not the draft's. These pages exist so the audit's
 * findings are produced by a real `ModelContext` in a real browser rather than
 * a hand-written object, and so a run that silently collected nothing cannot
 * satisfy the suite.
 *
 * The core is served from the workspace rather than bundled, so a fixture can
 * never drift from what a consumer actually installs.
 */

import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CORE_BUNDLE = resolve(here, "../../core/dist/index.mjs");

/**
 * One fixture per finding class. Each is a self-contained module that installs
 * the core and registers the tools for its class.
 */
const FIXTURES: Record<string, string> = {
	// No tools at all. The quiet case: "no tools" is a real answer, not a bug.
	empty: `
		globalThis.__install(document);
		globalThis.__fixture = "empty";
	`,

	// Typed, schema-valid, consequential annotated, read-only sane, narrow
	// exposure, within every budget. The passing baseline.
	clean: `
		const mc = globalThis.__install(document);
		await mc.registerTool({
			name: "viewCart",
			description: "Show the current cart contents.",
			inputSchema: {
				type: "object",
				properties: { detailed: { type: "boolean", description: "Include line items." } },
			},
			execute: async () => ({ items: 2 }),
		});
		await mc.registerTool({
			name: "placeOrder",
			description: "Place an order for the current cart. Charges the card.",
			inputSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
			annotations: { consequentialHint: true },
			execute: async () => ({ placed: true }),
		});
		globalThis.__fixture = "clean";
	`,

	// Registered without an input schema at all.
	untyped: `
		const mc = globalThis.__install(document);
		await mc.registerTool({
			name: "bareTool",
			description: "A tool with no input schema.",
			execute: async () => null,
		});
		globalThis.__fixture = "untyped";
	`,

	// read-only and consequential together: the inverted annotation.
	inverted: `
		const mc = globalThis.__install(document);
		await mc.registerTool({
			name: "refundOrder",
			description: "Refund an order. Sends money back to the card.",
			annotations: { readOnlyHint: true, consequentialHint: true },
			execute: async () => ({ refunded: true }),
		});
		globalThis.__fixture = "inverted";
	`,

	// Tools registered, none of them annotated consequential.
	// Consequential coverage then reports 0 of N rather than passing.
	noConsequential: `
		const mc = globalThis.__install(document);
		await mc.registerTool({
			name: "deleteEverything",
			description: "Delete every record for this account. Irreversible.",
			inputSchema: { type: "object", properties: {} },
			execute: async () => null,
		});
		globalThis.__fixture = "noConsequential";
	`,

	// Exposure over-broad by count. Four trusted origins is past the narrow
	// threshold, so the exposure check fails on a tool the core genuinely
	// accepted — a wildcard cannot be produced here, because the core's origin
	// parser rejects one before it is ever recorded.
	overBroad: `
		const mc = globalThis.__install(document);
		await mc.registerTool({
			name: "wideTool",
			description: "Visible to four separate origins.",
			execute: async () => null,
		}, {
			exposedTo: [
				"http://127.0.0.1:1",
				"http://localhost:2",
				"http://127.0.0.1:3",
				"http://127.0.0.1:4",
			],
		});
		globalThis.__fixture = "overBroad";
	`,

	// Names and descriptions past their character budgets.
	overlong: `
		const mc = globalThis.__install(document);
		await mc.registerTool({
			name: "aVeryLongToolNameThatExceedsTheBudget",
			description: "x".repeat(600),
			inputSchema: { type: "object", properties: {} },
			execute: async () => null,
		});
		globalThis.__fixture = "overlong";
	`,

	// A page whose own claims about its tools are wrong: the core is never
	// installed, and an impostor context is defined directly on the document.
	// The core's `installModelContext` deliberately refuses to overwrite an
	// existing value, so this is exactly what a page that never installed the
	// core can look like from the outside.
	forged: `
		globalThis.__fixture = "forged";
		const impostor = {
			getTools: async () => [
				{
					name: "totallySafe",
					description: "Claims to be safe.",
					inputSchema: "not-a-schema",
					annotations: { consequentialHint: true },
				},
				{ name: "wildClaim", description: "Wide claim.", exposedOrigins: ["*"] },
			],
		};
		Object.defineProperty(document, "modelContext", {
			value: impostor,
			writable: false,
			configurable: false,
			enumerable: true,
		});
	`,
};

export interface FixtureServer {
	readonly origin: string;
	close(): Promise<void>;
}

/**
 * Serve the fixtures over loopback HTTP. Loopback is a potentially trustworthy
 * origin, so the core installs without a TLS shim.
 */
export async function serveFixtures(): Promise<FixtureServer> {
	const core = await readFile(CORE_BUNDLE, "utf8");
	const pages: Record<string, string> = {};
	for (const [name, source] of Object.entries(FIXTURES)) {
		// The fixture body runs inside an async function so it can use dynamic
		// import and top-level await. A static `import` statement is only legal
		// at a module's top level, so wrapping the source in `try` directly would
		// be a syntax error rather than a caught rejection.
		pages[`/${name}`] = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${name}</title></head>
<body>
<h1>fixture: ${name}</h1>
<script type="module">
const { installModelContext } = await import("/core.mjs");
globalThis.__install = installModelContext;
async function main() {
${source}
}
main().catch((error) => {
	globalThis.__fixtureError = String(error);
});
</script>
</body>
</html>`;
	}

	const server: Server = createServer((request, response) => {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
		if (path === "/core.mjs") {
			response.writeHead(200, { "content-type": "text/javascript" });
			response.end(core);
			return;
		}
		const page = pages[path];
		if (page === undefined) {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("no such fixture");
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(page);
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new TypeError("fixture server has no port");
	}
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
