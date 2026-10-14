// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
	checkBearer,
	checkRelayOrigin,
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
			resolveDiscoveryDir(
				{ XDG_RUNTIME_DIR: "/run/user/1000" },
				(message) => warnings.push(message),
				"linux",
			),
		).toBe(join("/run/user/1000", "ax"));
		expect(warnings).toHaveLength(0);
		expect(
			resolveDiscoveryDir(
				{ HOME: "/home/op" },
				(message) => warnings.push(message),
				"linux",
			),
		).toBe(join("/home/op", ".ax"));
		expect(warnings).toHaveLength(1);
		expect(() => resolveDiscoveryDir({}, undefined, "linux")).toThrow(
			TypeError,
		);
	});

	it("resolves on Windows, where neither XDG nor HOME is normally set", () => {
		// A plain `cmd.exe` has neither of the two variables the POSIX branch
		// reads, so a bridge keyed on them throws on the platform it is developed
		// on. `LOCALAPPDATA` is the user-only directory on Windows, and the only
		// one of the three that can hold a file no other user can read.
		const warnings: string[] = [];
		const onWarn = (message: string): void => {
			warnings.push(message);
		};
		// The values are deliberately not shaped like a real machine's paths. They
		// stand in for "a directory this platform would have supplied", and a
		// fixture that looks like someone's actual home directory is a name in
		// this repository that refers to a machine nobody here has.
		expect(
			resolveDiscoveryDir(
				{ LOCALAPPDATA: "<local-app-data>" },
				onWarn,
				"win32",
			),
		).toBe(join("<local-app-data>", "ax-kit"));
		expect(warnings).toHaveLength(0);
		// A Git Bash shell has HOME and no LOCALAPPDATA; a cmd.exe shell has
		// neither. Both must land somewhere rather than throwing.
		expect(
			resolveDiscoveryDir({ USERPROFILE: "<user-profile>" }, onWarn, "win32"),
		).toBe(join("<user-profile>", ".ax-kit"));
		expect(resolveDiscoveryDir({ HOME: "<user-home>" }, onWarn, "win32")).toBe(
			join("<user-home>", ".ax-kit"),
		);
		expect(() => resolveDiscoveryDir({}, onWarn, "win32")).toThrow(TypeError);
		// The POSIX variable does not win on Windows: a WSL-exported
		// XDG_RUNTIME_DIR describes a different filesystem namespace entirely.
		expect(
			resolveDiscoveryDir(
				{ XDG_RUNTIME_DIR: "/run/user/1000", LOCALAPPDATA: "<local>" },
				onWarn,
				"win32",
			),
		).toBe(join("<local>", "ax-kit"));
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

	it("admits the extension origin to the relay and still refuses the web", () => {
		expect(() =>
			checkRelayOrigin("chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik"),
		).not.toThrow();
		// The browser's own spelling, measured by logging what it sends to a
		// native host: the trailing slash is part of the value, and a gate that
		// omits it refuses the caller it exists to admit.
		expect(() =>
			checkRelayOrigin("chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/"),
		).not.toThrow();
		expect(() => checkRelayOrigin("http://127.0.0.1:41237/")).not.toThrow();
		const refused = [
			"https://evil.test/",
			"http://127.0.0.1.evil.test/",
			"chrome-extension://abc",
			"chrome-extension://qnldjmfmopnpolahpmmgbagdohdnhkik",
			"chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/path.html",
			// An opaque origin is what a sandboxed document sends. It is a page.
			"null",
		];
		for (const origin of refused) {
			expect(() => checkRelayOrigin(origin), origin).toThrow(TypeError);
		}
	});

	it("admits an absent origin, which the extension's own fetch sends", () => {
		// An extension holding host permissions makes a privileged fetch, which
		// the browser exempts from CORS: no preflight, and no `Origin` header
		// either. Requiring one refused the extension on every request - the
		// listener's 403 said so, from a caller that was exactly who it claimed.
		//
		// This is not the gate being loosened past a page. A page holds no host
		// permissions, its fetch is ordinary CORS, and `Origin` is required on a
		// non-simple request - which is why a page's origin is present, checked,
		// and refused above. A caller presenting none has already shown it is not
		// a page. The bearer is what authenticates it.
		expect(() => checkRelayOrigin(undefined)).not.toThrow();
		// Not a missing header: a header that is not a string is a malformed
		// request, and admitting that would be admitting anything.
		expect(() => checkRelayOrigin(null)).toThrow(TypeError);
		expect(() => checkRelayOrigin(42)).toThrow(TypeError);
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
