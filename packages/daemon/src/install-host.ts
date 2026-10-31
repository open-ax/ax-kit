// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Registering the broker where a browser will actually launch it.
 *
 * Everything here is ours, not draft-derived. The draft defines the page
 * surface; this is how a browser finds a process on this machine.
 *
 * **Windows is not a directory, it is a registry key.** The manifest may live
 * anywhere on Windows; the browser finds it by reading the default value of
 * `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>`. Writing the file
 * into a plausible-looking directory and stopping there produces a host that is
 * registered with nobody and never launched — which is a bridge that fails
 * silently, which is the worst shape a failure can have.
 *
 * **macOS and Linux are directories.** The manifest goes in the user-level
 * `NativeMessagingHosts/` under the browser's own configuration directory, and
 * the browser looks there.
 *
 * **Windows gets a `.cmd`, not the script.** Chromium launches an `.exe`
 * directly and routes everything else through `COMSPEC`, so a `.cmd` shim is
 * the shape that works without shipping a compiled launcher. Pointing the
 * manifest straight at `node` is a bare interpreter everywhere.
 *
 * All three were checked against the Chrome extension documentation on
 * 2026-10-14. An earlier version of this file got Windows wrong and was
 * corrected by a separate verification pass.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createNativeHostManifest } from "./native-host.js";

export const HOST_NAME = "com.openax.axkit" as const;

/**
 * The registry key Windows uses to find a native-messaging manifest.
 *
 * `HKEY_CURRENT_USER` rather than `HKEY_LOCAL_MACHINE`: the machine hive needs
 * elevation, and per-user registration is what someone running one browser
 * account actually wants. Chrome reads the 32-bit view first, then the 64-bit.
 */
export const WINDOWS_REGISTRY_KEY =
	"HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" as const;

/** Where the manifest goes when the caller names no directory. */
export function defaultManifestDir(
	env: NodeJS.ProcessEnv,
	home: string,
	platform: string = process.platform,
): string {
	if (platform === "darwin") {
		return join(home, "Library", "Application Support", "Google", "Chrome");
	}
	if (platform === "win32") {
		const local = env.LOCALAPPDATA;
		if (typeof local === "string" && local.length > 0) {
			return join(local, "ax-kit");
		}
		return join(home, ".ax-kit");
	}
	return join(home, ".config", "google-chrome");
}

/** The absolute path a manifest belongs at, under one directory. */
export function hostManifestPath(
	directory: string,
	// The directory layout is the same on every platform; only *where it is*
	// differs, and that is `defaultManifestDir`'s job. The parameter stays so a
	// caller can assert the path for a platform it is not running on.
	_platform: string = process.platform,
): string {
	return join(directory, "NativeMessagingHosts", `${HOST_NAME}.json`);
}

/**
 * The command the manifest launches.
 *
 * On Windows that is a generated `.cmd`; everywhere else it is the broker
 * script itself, which carries a shebang.
 */
export interface Launcher {
	/** The path to put in the manifest's `path`. */
	readonly path: string;
	/** Where the launcher was written, if one was generated. */
	readonly written: string | null;
}

export function launcherFor(
	brokerScript: string,
	platform: string = process.platform,
): Launcher {
	const absolute = resolve(brokerScript);
	if (platform !== "win32") {
		try {
			chmodSync(absolute, 0o755);
		} catch {
			// A filesystem that will not carry the bit still launches through a
			// working interpreter, and that is not worth refusing registration over.
		}
		return { path: absolute, written: null };
	}
	// `COMSPEC` is set on Windows and absent elsewhere; the literal fallback is
	// the documented default when a process has a stripped environment.
	const cmd = process.env.COMSPEC ?? "cmd.exe";
	// `cmd.exe` consumes the first quoted token as the program and the rest as
	// one argument string, so a path containing a quote cannot be quoted safely.
	if (absolute.includes('"')) {
		throw new TypeError("the broker path may not contain a double quote");
	}
	const shim = `${absolute}.cmd`;
	writeFileSync(
		shim,
		[
			"@echo off",
			// The space before `%*` is load-bearing and was missing once.
			//
			// `%*` is the caller's arguments — the extension origin and, on
			// Windows, `--parent-window=…` — and the broker authenticates on the
			// first of them. Written adjacent to the closing quote, cmd.exe is
			// free to read `C:\repo\script.mjschrome-extension://…` as one token,
			// and the host then starts with no origin to check and refuses every
			// connection as though no browser had called it.
			//
			// A separate shim with the space in it worked and this one without
			// it did not, which is why the integration test did not catch it: it
			// had been writing its own launcher rather than this one.
			`"${cmd}" /d /s /c ""${process.execPath}" "${absolute}" %*"`,
			"",
		].join("\r\n"),
		{ mode: 0o755 },
	);
	return { path: shim, written: shim };
}

export interface InstallOptions {
	/** Directory the manifest is written under. */
	readonly directory: string;
	readonly brokerScript: string;
	readonly extensionId: string;
	readonly platform?: string;
}

/** What a registration produced, and how the browser will find it. */
export interface InstallResult {
	readonly manifestPath: string;
	readonly launcher: Launcher;
	/**
	 * The registry key pointing at the manifest, on Windows only.
	 *
	 * Null elsewhere because there is no key to write: macOS and Linux are found
	 * by looking in a fixed directory. Reporting it rather than hiding it lets a
	 * caller say something true about what it just did.
	 */
	readonly registryKey: string | null;
}

/**
 * The `reg add` invocation that points a browser at a manifest on Windows.
 *
 * `reg.exe` rather than a registry library because it is present on every
 * Windows install and this package has no runtime dependencies. Built as an
 * argument array so a path containing a space or a quote cannot become part of
 * the command.
 */
export function registryCommand(manifestPath: string): {
	readonly file: string;
	readonly args: ReadonlyArray<string>;
} {
	return {
		file: "reg.exe",
		args: [
			"add",
			`${WINDOWS_REGISTRY_KEY}\\${HOST_NAME}`,
			"/ve",
			"/t",
			"REG_SZ",
			"/d",
			manifestPath,
			"/f",
		],
	};
}

/**
 * Write the manifest a browser needs to launch the broker, and register it.
 *
 * `extensionId` is the extension's own id, and `allowed_origins` is what decides
 * whether Chrome will run this for that extension at all. It is required rather
 * than defaulted: a manifest admitting any origin would be a host process that
 * any installed extension could launch.
 */
export function installNativeHost(options: InstallOptions): InstallResult {
	const platform = options.platform ?? process.platform;
	if (!/^[a-p]{32}$/.test(options.extensionId)) {
		throw new TypeError("an extension id is 32 characters from a-p");
	}
	const launcher = launcherFor(options.brokerScript, platform);
	const manifest = createNativeHostManifest({
		name: HOST_NAME,
		description: "ax-kit bridge",
		path: launcher.path,
		type: "stdio",
		allowed_origins: [`chrome-extension://${options.extensionId}/`],
	});
	const manifestPath = hostManifestPath(options.directory, platform);
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
		mode: 0o600,
	});
	if (platform !== "win32") {
		return { manifestPath, launcher, registryKey: null };
	}
	// The file alone is not a registration on Windows. Without this key the
	// browser never looks in the directory the manifest was just written to.
	const command = registryCommand(manifestPath);
	const result = spawnSync(command.file, [...command.args], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim();
		throw new TypeError(
			`could not register the native host in the registry${
				detail === "" ? "" : `: ${detail}`
			}`,
		);
	}
	return {
		manifestPath,
		launcher,
		registryKey: `${WINDOWS_REGISTRY_KEY}\\${HOST_NAME}`,
	};
}

/** What a person needs when registration fails. */
export function installFailure(platform: string = process.platform): string {
	if (platform === "win32") {
		return [
			"On Windows the manifest is found through a registry key rather than a",
			"directory. If the key cannot be written, run this from an elevated",
			"shell, or add the key by hand:",
			`  reg add "${WINDOWS_REGISTRY_KEY}\\${HOST_NAME}" /ve /t REG_SZ /d "<manifest path>" /f`,
		].join("\n");
	}
	return "Could not write the native host manifest into the profile directory.";
}
