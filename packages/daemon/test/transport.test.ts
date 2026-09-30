// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
	checkBearer,
	checkUpgradeOrigin,
	createDiscoveryFile,
	isLoopbackHost,
	parseDiscoveryFile,
	resolveDiscoveryDir,
} from "../src/discovery.js";
import {
	assertWorkerReachable,
	checkMessageSize,
	createNativeHostManifest,
	sanitizeRendererPayload,
	windowsRegistryValue,
} from "../src/native-host.js";
import { assertStdoutClean, isStdinClosed, splitFrames } from "../src/stdio.js";

describe("stdio hygiene", () => {
	it("keeps stdout to one protocol frame per line", () => {
		assertStdoutClean(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1 })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2 })}\n`,
		);
		expect(() => assertStdoutClean("log line\n")).toThrow(TypeError);
		expect(() => assertStdoutClean("[debug] booted\n")).toThrow(TypeError);
	});

	it("splits buffered bytes and treats stdin close as shutdown", () => {
		const split = splitFrames("a\nb\npartial");
		expect(split.lines).toEqual(["a", "b"]);
		expect(split.rest).toBe("partial");
		expect(isStdinClosed(null)).toBe(true);
		expect(isStdinClosed("bytes")).toBe(false);
	});
});

describe("local transport", () => {
	it("carries port, pid, token, and version", () => {
		const file = createDiscoveryFile({
			port: 41237,
			pid: 1234,
			token: "0123456789abcdef",
			version: "2026-07-28",
		});
		expect(file.port).toBe(41237);
		expect(parseDiscoveryFile(JSON.stringify(file)).token).toBe(file.token);
		expect(() =>
			createDiscoveryFile({
				port: 0,
				pid: 1,
				token: "x".repeat(16),
				version: "v",
			}),
		).toThrow(TypeError);
	});

	it("prefers the runtime dir with a home fallback", () => {
		expect(resolveDiscoveryDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
			"/run/user/1000/ax",
		);
		expect(resolveDiscoveryDir({ HOME: "/home/op" })).toBe("/home/op/.ax");
		expect(() => resolveDiscoveryDir({})).toThrow(TypeError);
	});

	it("binds loopback with bearer and origin checks", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("example.com")).toBe(false);
		expect(() =>
			checkBearer("secret-value-0001", "secret-value-0001"),
		).not.toThrow();
		expect(() => checkBearer("wrong", "secret-value-0001")).toThrow(TypeError);
		expect(() => checkUpgradeOrigin("http://127.0.0.1:41237/")).not.toThrow();
		expect(() => checkUpgradeOrigin("https://example.com/")).toThrow(TypeError);
	});
});

describe("native host", () => {
	it("requires an absolute shim path and a manifest document on Windows", () => {
		const manifest = createNativeHostManifest({
			name: "com.openax.bridge",
			description: "ax-kit bridge",
			path: "/usr/local/bin/ax-bridge",
			type: "stdio",
			allowed_origins: ["chrome-extension://abcdef"],
		});
		expect(manifest.type).toBe("stdio");
		expect(windowsRegistryValue("/host/bridge.json")).toBe("/host/bridge.json");
		expect(() => windowsRegistryValue("/host/bridge.exe")).toThrow(TypeError);
		expect(() =>
			createNativeHostManifest({
				name: "com.openax.bridge",
				description: "x",
				path: "node src/index.js",
				type: "stdio",
				allowed_origins: [],
			}),
		).toThrow(TypeError);
		expect(() =>
			createNativeHostManifest({
				name: "com.openax.bridge",
				description: "x",
				path: "/bin/bridge",
				type: "stdio",
				allowed_origins: ["*"],
			}),
		).toThrow(TypeError);
	});

	it("honors size limits and worker-only reachability", () => {
		expect(() => checkMessageSize(10, "host-to-browser")).not.toThrow();
		expect(() => checkMessageSize(2 * 1024 * 1024, "host-to-browser")).toThrow(
			TypeError,
		);
		expect(() => assertWorkerReachable("service-worker")).not.toThrow();
		expect(() => assertWorkerReachable("content-script")).toThrow(TypeError);
	});

	it("sanitizes renderer input", () => {
		expect(sanitizeRendererPayload({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
		expect(() => sanitizeRendererPayload({ ["__proto__"]: 1 })).toThrow(
			TypeError,
		);
		expect(() => sanitizeRendererPayload({ nested: { a: 1 } })).toThrow(
			TypeError,
		);
	});
});
