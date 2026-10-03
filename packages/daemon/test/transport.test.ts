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
import { createNativeHostManifest } from "../src/native-host.js";
import { splitFrames } from "../src/stdio.js";

describe("stdio hygiene", () => {
	it("splits buffered bytes and keeps the remainder", () => {
		const split = splitFrames("a\nb\npartial");
		expect(split.lines).toEqual(["a", "b"]);
		expect(split.rest).toBe("partial");
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

	it("prefers the runtime dir, warns on the home fallback", () => {
		const warnings: string[] = [];
		expect(
			resolveDiscoveryDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, (message) =>
				warnings.push(message),
			),
		).toBe("/run/user/1000/ax");
		expect(warnings).toHaveLength(0);
		expect(
			resolveDiscoveryDir({ HOME: "/home/op" }, (message) =>
				warnings.push(message),
			),
		).toBe("/home/op/.ax");
		expect(warnings).toHaveLength(1);
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
	it("accepts a well-formed manifest and refuses a bare interpreter", () => {
		const manifest = createNativeHostManifest({
			name: "com.openax.bridge",
			description: "ax-kit bridge",
			path: "/usr/local/bin/ax-bridge",
			type: "stdio",
			allowed_origins: ["chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/"],
		});
		expect(manifest.type).toBe("stdio");
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

	it("rejects relative paths, interpreters, and non-extension origins", () => {
		for (const badPath of [
			"./evil-bridge",
			"node bridge.js",
			"/usr/bin/python bridge.py",
		]) {
			expect(() =>
				createNativeHostManifest({
					name: "com.openax.bridge",
					description: "x",
					path: badPath,
					type: "stdio",
					allowed_origins: [
						"chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/",
					],
				}),
			).toThrow(TypeError);
		}
		expect(() =>
			createNativeHostManifest({
				name: "com.openax.bridge",
				description: "x",
				path: "/bin/bridge",
				type: "stdio",
				allowed_origins: ["https://evil.example"],
			}),
		).toThrow(TypeError);
		for (const badOrigin of [
			"chrome-extension://x/../",
			"chrome-extension://abcdef",
			"chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik",
		]) {
			expect(() =>
				createNativeHostManifest({
					name: "com.openax.bridge",
					description: "x",
					path: "/bin/bridge",
					type: "stdio",
					allowed_origins: [badOrigin],
				}),
			).toThrow(TypeError);
		}
	});
});

describe("frame caps", () => {
	it("refuses an oversized frame by bytes, not by characters", () => {
		expect(() => checkUpgradeOrigin("file://127.0.0.1/")).toThrow(TypeError);
		expect(() => splitFrames("x".repeat(2 * 1024 * 1024))).toThrow(TypeError);
		expect(() => splitFrames("界".repeat(400_000))).toThrow(TypeError);
		const many = splitFrames(`${"a".repeat(100)}\n${"b".repeat(100)}\nrest`);
		expect(many.lines).toEqual(["a".repeat(100), "b".repeat(100)]);
		expect(many.rest).toBe("rest");
	});
});
