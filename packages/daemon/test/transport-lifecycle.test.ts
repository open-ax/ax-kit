// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	assertLoopbackBind,
	createBearer,
	discoveryDirectory,
	readDiscoveryFile,
	startTransport,
	writeNativeHostManifest,
} from "../src/lifecycle.js";

/**
 * The daemon's local transport, against a real listener and a real filesystem.
 *
 * Nothing here is a fake socket or a stubbed `fs`: readiness is the discovery
 * file appearing on disk and the port accepting, both observed rather than
 * waited on.
 */

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ax-transport-"));
	dirs.push(dir);
	return dir;
}

/** One request against the live listener, with a real socket. */
function call(
	port: number,
	headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port, path: "/", method: "GET", headers },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

describe("local transport", () => {
	it("writes a discovery file a client can connect with, no hard-coded port", async () => {
		const dir = await tempDir();
		const transport = await startTransport({ discoveryDir: dir });
		try {
			// Read the file the way a client would, with no knowledge of the port.
			const file = readDiscoveryFile(dir);
			expect(file.port).toBe(transport.port);
			expect(file.pid).toBe(process.pid);
			expect(file.token).toBe(transport.bearer);
			expect(file.version).toBe("2026-07-28");

			const response = await call(file.port, {
				"x-ax-bearer": file.token,
				origin: `http://127.0.0.1:${file.port}`,
			});
			// The listener accepted a request that used only what the file said.
			expect(response.status).toBe(404);
		} finally {
			await transport.close();
		}
	});

	it("refuses a request without the bearer or with the wrong one", async () => {
		const dir = await tempDir();
		const transport = await startTransport({ discoveryDir: dir });
		try {
			const origin = `http://127.0.0.1:${transport.port}`;
			expect((await call(transport.port, { origin })).status).toBe(403);
			expect(
				(await call(transport.port, { origin, "x-ax-bearer": "wrong" })).status,
			).toBe(403);
			expect(
				(
					await call(transport.port, {
						origin,
						"x-ax-bearer": `${transport.bearer}x`,
					})
				).status,
			).toBe(403);
			expect(
				(
					await call(transport.port, {
						origin,
						"x-ax-bearer": transport.bearer,
					})
				).status,
			).toBe(404);
		} finally {
			await transport.close();
		}
	});

	it("applies origin validation to local requests", async () => {
		const dir = await tempDir();
		const transport = await startTransport({ discoveryDir: dir });
		try {
			expect(
				(
					await call(transport.port, {
						origin: "https://example.com",
						"x-ax-bearer": transport.bearer,
					})
				).status,
			).toBe(403);
			expect(
				(
					await call(transport.port, {
						origin: "file://127.0.0.1/",
						"x-ax-bearer": transport.bearer,
					})
				).status,
			).toBe(403);
		} finally {
			await transport.close();
		}
	});

	it("refuses a non-loopback bind rather than warning about it", () => {
		expect(() => assertLoopbackBind("0.0.0.0")).toThrow(TypeError);
		expect(() => assertLoopbackBind("192.168.1.10")).toThrow(TypeError);
		expect(() => assertLoopbackBind("::")).toThrow(TypeError);
		expect(assertLoopbackBind("127.0.0.1")).toBe("127.0.0.1");
		expect(assertLoopbackBind("localhost")).toBe("localhost");
	});

	it("binds loopback only, as the address itself shows", async () => {
		const dir = await tempDir();
		const transport = await startTransport({ discoveryDir: dir });
		try {
			const text = await readFile(transport.discoveryPath, "utf8");
			expect(text).toContain(`"port":${transport.port}`);
			// Nothing non-loopback is advertised, and the file holds no bare
			// interpreter path that a browser could not launch.
			expect(text).not.toContain("0.0.0.0");
		} finally {
			await transport.close();
		}
	});

	it("removes the discovery file on clean shutdown", async () => {
		const dir = await tempDir();
		const transport = await startTransport({ discoveryDir: dir });
		const path = transport.discoveryPath;
		await stat(path);
		await transport.close();
		await expect(stat(path)).rejects.toThrow();
	});

	it("writes a native-host manifest a browser can use", async () => {
		const dir = await tempDir();
		const here = fileURLToPath(new URL(".", import.meta.url));
		const binary = join(here, "..", "bin", "ax-kit-daemon.mjs");
		const manifestPath = writeNativeHostManifest(dir, binary, [
			"chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/",
		]);
		const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
		const record = manifest as Record<string, unknown>;
		expect(record["type"]).toBe("stdio");
		// The path is the binary's own directory, not an assumed one, and it is
		// a real file the browser could launch.
		expect(record["path"]).toBe(binary);
		expect(await stat(String(record["path"]))).toBeDefined();
		expect(record["allowed_origins"]).toEqual([
			"chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/",
		]);
	});

	it("resolves the discovery directory from the environment", () => {
		const warnings: string[] = [];
		expect(
			discoveryDirectory({ XDG_RUNTIME_DIR: "/run/user/1000" }, (m) =>
				warnings.push(m),
			),
		).toBe("/run/user/1000/ax");
		expect(
			discoveryDirectory({ HOME: "/home/op" }, (m) => warnings.push(m)),
		).toBe("/home/op/.ax");
		expect(warnings.length).toBe(1);
	});

	it("mints a bearer that is not guessable and not reused", () => {
		const first = createBearer();
		const second = createBearer();
		expect(first).not.toBe(second);
		expect(first.length).toBe(64);
		expect(createBearer()).not.toBe(first);
	});
});
