// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { IDL_HARNESS_PATH, SUITE_ROOT } from "./wpt.js";

/**
 * A real server for the pinned suite, on real origins.
 *
 * The earlier runner fulfilled `page.route` requests from one synthetic origin.
 * That can express a page and its scripts, and nothing else: there is no second
 * origin, no response headers, and no way to serve a document under a content
 * security policy. Twelve of the suite's files need a genuinely different
 * origin and several need a header, so they could only be recorded as
 * unexplained failures.
 *
 * Three origins are served, all loopback:
 *
 *   self               same origin as the page under test
 *   remote             cross-origin, same site (same host, different port)
 *   otherNotSameSite   cross-origin, a different site (a different loopback
 *                      address, because a site is computed without the port)
 *
 * Loopback addresses are potentially trustworthy, so every origin served here
 * is a secure context even though the scheme is `http`.
 */
export interface SuiteOrigins {
	readonly self: string;
	readonly remote: string;
	readonly otherNotSameSite: string;
}

export interface SuiteServer {
	readonly origins: SuiteOrigins;
	close(): Promise<void>;
}

/** The page the suite's interface-definition harness is run from. */
export const IDL_HARNESS_PAGE_PATH: string = `/${IDL_HARNESS_PATH.replace(/\.js$/, ".html")}`;

/**
 * A minimal document for `/`. One suite file points a frame at the origin root
 * to obtain the initial `about:blank` document, so the root has to answer with
 * a real navigation rather than a 404.
 */
const ROOT_DOCUMENT = "<!DOCTYPE html>\n<title>ax-kit suite server</title>\n";

function contentTypeFor(path: string): string {
	if (path.endsWith(".js")) {
		return "text/javascript; charset=utf-8";
	}
	if (path.endsWith(".idl")) {
		return "text/plain; charset=utf-8";
	}
	return "text/html; charset=utf-8";
}

/**
 * Upstream's `common/get-host-info.sub.js` is a template that `wptserve` fills
 * in with the ports and hostnames of whichever machine is running the suite.
 * The same substitution is made here, against the origins above, and the suite
 * files that include it are served unmodified.
 *
 * The suite reads three fields. The `HTTPS_` prefix is upstream's name for the
 * secure-context origin; these origins are loopback addresses, which the
 * platform also treats as potentially trustworthy, so a secure context is what
 * those names still describe. `HTTPS_REMOTE_ORIGIN` is cross-origin and same
 * site, `HTTPS_OTHER_NOTSAMESITE_ORIGIN` is cross-origin and a different site,
 * which is the distinction the two names exist to express.
 */
function hostInfoScript(origins: SuiteOrigins): string {
	return `// Generated in place of common/get-host-info.sub.js. See the runner's
// source for why this file is substituted rather than the suite.
function get_host_info() {
  return {
    HTTPS_ORIGIN: ${JSON.stringify(origins.self)},
    HTTPS_REMOTE_ORIGIN: ${JSON.stringify(origins.remote)},
    HTTPS_OTHER_NOTSAMESITE_ORIGIN: ${JSON.stringify(origins.otherNotSameSite)},
  };
}
`;
}

/**
 * The page the interface-definition harness runs from. Upstream ships the
 * harness as a script and its own `META:` comments name the scripts it needs;
 * the wrapper page that combines them is what a WPT server generates, and it is
 * generated here for the same reason.
 */
function idlHarnessPage(): string {
	return `<!DOCTYPE html>
<meta charset="utf-8">
<title>WebMCP interface definitions</title>
<script src="/resources/testharness.js"></script>
<script src="/resources/testharnessreport.js"></script>
<script src="/resources/webidl2/lib/webidl2.js"></script>
<script src="/resources/idlharness.js"></script>
<script src="/${IDL_HARNESS_PATH}"></script>
`;
}

function listen(server: Server, host: string, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			const address = server.address() as AddressInfo;
			resolve(address.port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.closeAllConnections();
		server.close(() => {
			resolve();
		});
	});
}

/**
 * Serve `bodies`, keyed by repository path with no leading slash, on the three
 * loopback origins. `reporter` replaces `resources/testharnessreport.js`,
 * which upstream documents as the file for vendors to integrate with their own
 * test systems.
 *
 * A `<path>.headers` file beside a served path is applied as response headers
 * for that path, which is how the suite asks for a document to be served inside
 * a content security policy sandbox.
 */
/**
 * Insert the install script into an HTML document.
 *
 * Placement matters in one direction only: it must come before the document's
 * own scripts, and it must not precede the doctype, which would put the document
 * into quirks mode and change what the suite is testing.
 */
export function injectInstallTag(html: string, src: string): string {
	const tag = `<script src="${src}"></script>`;
	const head = /<head\b[^>]*>/i.exec(html);
	if (head !== null) {
		return `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`;
	}
	const root = /<html\b[^>]*>/i.exec(html);
	if (root !== null) {
		return `${html.slice(0, root.index + root[0].length)}<head>${tag}</head>${html.slice(root.index + root[0].length)}`;
	}
	const doctype = /<!doctype\b[^>]*>/i.exec(html);
	if (doctype !== null) {
		const at = doctype.index + doctype[0].length;
		return `${html.slice(0, at)}<html><head>${tag}</head>${html.slice(at)}`;
	}
	return `<head>${tag}</head>${html}`;
}

export async function startSuiteServer(
	bodies: ReadonlyMap<string, string>,
	reporter: string,
	install: { readonly path: string; readonly source: string },
): Promise<SuiteServer> {
	const overrides = new Map<string, { body: string; type: string }>([
		["/", { body: ROOT_DOCUMENT, type: "text/html; charset=utf-8" }],
		[
			"/resources/testharnessreport.js",
			{ body: reporter, type: "text/javascript; charset=utf-8" },
		],
		[
			install.path,
			{ body: install.source, type: "text/javascript; charset=utf-8" },
		],
		[
			IDL_HARNESS_PAGE_PATH,
			{ body: idlHarnessPage(), type: "text/html; charset=utf-8" },
		],
	]);

	const handler = (
		request: import("node:http").IncomingMessage,
		response: import("node:http").ServerResponse,
	): void => {
		const requestPath = new URL(request.url ?? "/", "http://127.0.0.1")
			.pathname;
		const override = overrides.get(requestPath);
		if (override !== undefined) {
			const served = override.type.startsWith("text/html")
				? injectInstallTag(override.body, install.path)
				: override.body;
			response.writeHead(200, {
				"content-type": override.type,
				"cache-control": "no-store",
			});
			response.end(served);
			return;
		}
		const path = requestPath.replace(/^\//, "");
		const body = bodies.get(path);
		if (body === undefined) {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end(`not served: ${requestPath}`);
			return;
		}
		const headers: Record<string, string> = {
			"content-type": contentTypeFor(path),
			"cache-control": "no-store",
		};
		const extra = bodies.get(`${path}.headers`);
		if (extra !== undefined) {
			for (const line of extra.split("\n")) {
				const separator = line.indexOf(":");
				if (separator > 0) {
					headers[line.slice(0, separator).trim()] = line
						.slice(separator + 1)
						.trim();
				}
			}
		}
		// Every document that arrives over HTTP gets the bundle, in every engine,
		// in every frame. This is the deterministic route: a browser-context init
		// script reaches main frames and subframes inconsistently across engines,
		// and a suite whose results depend on that is not a suite.
		const served = path.endsWith(".html")
			? injectInstallTag(body, install.path)
			: body;
		response.writeHead(200, headers);
		response.end(served);
	};

	const self = createServer(handler);
	const selfPort = await listen(self, "127.0.0.1", 0);
	// A different loopback address on the same port: a different site, because a
	// site is computed from the scheme and the address without the port.
	const other = createServer(handler);
	await listen(other, "127.0.0.2", selfPort);
	const remote = createServer(handler);
	const remotePort = await listen(remote, "127.0.0.1", 0);

	const origins: SuiteOrigins = {
		self: `http://127.0.0.1:${selfPort}`,
		remote: `http://127.0.0.1:${remotePort}`,
		otherNotSameSite: `http://127.0.0.2:${selfPort}`,
	};
	overrides.set("/common/get-host-info.sub.js", {
		body: hostInfoScript(origins),
		type: "text/javascript; charset=utf-8",
	});

	return {
		origins,
		close: async () => {
			await Promise.all([close(self), close(remote), close(other)]);
		},
	};
}

/** Every served path, in the order a report should mention it. */
export function servedPaths(bodies: ReadonlyMap<string, string>): string[] {
	return [...bodies.keys()]
		.filter((path) => !path.endsWith(".headers"))
		.sort((left, right) => {
			if (left.startsWith(SUITE_ROOT) && !right.startsWith(SUITE_ROOT)) {
				return -1;
			}
			if (!left.startsWith(SUITE_ROOT) && right.startsWith(SUITE_ROOT)) {
				return 1;
			}
			return left.localeCompare(right);
		});
}
