// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	defaultManifestDir,
	HOST_NAME,
	hostManifestPath,
	installNativeHost,
	launcherFor,
	registryCommand,
	WINDOWS_REGISTRY_KEY,
} from "../src/install-host.js";

/**
 * Registration, against a real filesystem.
 *
 * The manifest is the only thing standing between a browser and an arbitrary
 * process, so the assertions are about what it says and where it landed — not
 * about the helper's return value.
 *
 * Every one of these was checked against the Chrome extension documentation on
 * 2026-10-14, after a separate verification pass found that Windows was wrong.
 */

const EXTENSION = "knldjmfmopnpolahpmmgbagdohdnhkik";
const dirs: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ax-install-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("native host registration", () => {
	it("writes a manifest a browser would launch, under the directory given", () => {
		const directory = scratch();
		const broker = join(scratch(), "ax-kit-browser-host.mjs");
		const result = installNativeHost({
			directory,
			brokerScript: broker,
			extensionId: EXTENSION,
			platform: "linux",
		});
		expect(result.manifestPath).toBe(hostManifestPath(directory, "linux"));
		const manifest = JSON.parse(
			readFileSync(result.manifestPath, "utf8"),
		) as Record<string, unknown>;
		expect(manifest["name"]).toBe(HOST_NAME);
		expect(manifest["type"]).toBe("stdio");
		// The one field that decides whether Chrome will run this at all. An
		// empty list, or a wildcard, would be a host process any installed
		// extension could launch.
		expect(manifest["allowed_origins"]).toEqual([
			`chrome-extension://${EXTENSION}/`,
		]);
		expect(manifest["path"]).toBe(broker);
		// No key exists off Windows; the directory is the whole registration.
		expect(result.registryKey).toBeNull();
	});

	it("registers through the registry on Windows, because that is how it is found", () => {
		// The browser does not search a directory on Windows. It reads a
		// registry key whose default value is the manifest's full path. Writing
		// the file and stopping there produces a host nobody will ever launch.
		const command = registryCommand("C:\\somewhere\\com.openax.axkit.json");
		expect(command.file).toBe("reg.exe");
		expect(command.args).toContain("add");
		expect(command.args).toContain(`${WINDOWS_REGISTRY_KEY}\\${HOST_NAME}`);
		expect(command.args).toContain("REG_SZ");
		expect(command.args).toContain("C:\\somewhere\\com.openax.axkit.json");
		// The 32-bit view is read first, so HKCU under the documented spelling is
		// the key that will be found.
		expect(
			WINDOWS_REGISTRY_KEY.startsWith("HKCU\\Software\\Google\\Chrome"),
		).toBe(true);
	});

	it("defaults to the directory each platform actually looks in", () => {
		// The stand-ins are deliberately not shaped like a real machine's paths.
		// They mean "a home directory this platform would have supplied", and a
		// fixture shaped like someone's actual home is a name in this repository
		// that refers to a machine nobody here has.
		// macOS and Linux: a fixed location under the user's own configuration,
		// because that is where the browser looks.
		expect(defaultManifestDir({}, "<home>", "darwin")).toBe(
			join("<home>", "Library", "Application Support", "Google", "Chrome"),
		);
		expect(defaultManifestDir({}, "<home>", "linux")).toBe(
			join("<home>", ".config", "google-chrome"),
		);
		// Windows: anywhere, because the registry says where. `%LOCALAPPDATA%` is
		// the per-user directory, which is the right home for a file only that
		// user should be able to read.
		expect(
			defaultManifestDir(
				{ LOCALAPPDATA: "<local-app-data>" },
				"<user-profile>",
				"win32",
			),
		).toBe(join("<local-app-data>", "ax-kit"));
	});

	it("generates a .cmd launcher on Windows and the script itself elsewhere", () => {
		// Chromium launches an `.exe` directly and routes everything else through
		// `COMSPEC`; a manifest pointing straight at `node` is a bare interpreter.
		// So Windows needs a `.cmd`, and only Windows.
		const broker = join(scratch(), "ax-kit-browser-host.mjs");
		const windows = launcherFor(broker, "win32");
		expect(windows.path.endsWith(".cmd")).toBe(true);
		expect(windows.written).not.toBeNull();

		// The space between the script path and `%*` is load-bearing. `%*` is the
		// caller's arguments — the extension origin the broker authenticates on,
		// plus `--parent-window=…` — and written adjacent to the closing quote,
		// cmd.exe can read `script.mjschrome-extension://…` as one token. The host
		// then starts with no origin and refuses every connection.
		//
		// This went uncaught because the integration test wrote its own shim,
		// with the space in it, rather than using this launcher.
		const shim = readFileSync(windows.written as string, "utf8");
		expect(shim).toContain(`"${broker}" %*`);
		expect(shim).not.toContain(`"${broker}"%*`);

		const posix = launcherFor(broker, "linux");
		expect(posix.path).toBe(broker);
		// POSIX launches the script itself, so the executable bit has to be set or
		// the shebang is decoration.
		expect(posix.written).toBeNull();
	});

	it("refuses an extension id that is not one", () => {
		// The id is the only thing binding this host to this extension, so a
		// malformed one is refused rather than normalised into something that
		// looks plausible.
		for (const id of [
			"",
			"short",
			`${EXTENSION}x`,
			EXTENSION.toUpperCase(),
			"*.test",
		]) {
			expect(
				() =>
					installNativeHost({
						directory: scratch(),
						brokerScript: join(scratch(), "host.mjs"),
						extensionId: id,
						platform: "linux",
					}),
				id,
			).toThrow(TypeError);
		}
	});
});
