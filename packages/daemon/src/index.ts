// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Stateless MCP bridge over stdio with local transport and native host.
 *
 * Everything here is ours, not the draft's: the draft defines the page
 * surface, while this entry speaks the client protocol on the other side
 * of the bridge. Modern-only behavior follows MCP `2026-07-28` with no
 * handshake, no session header, and no deprecated capabilities.
 */

export type { DiscoveryFile } from "./discovery.js";
export {
	checkBearer,
	checkUpgradeOrigin,
	createDiscoveryFile,
	DISCOVERY_FILE_NAME,
	discoveryFileName,
	isLoopbackHost,
	parseDiscoveryFile,
	resolveDiscoveryDir,
	serializeDiscoveryFile,
} from "./discovery.js";
export type { NativeHostManifest } from "./native-host.js";
export {
	assertWorkerReachable,
	BROWSER_TO_HOST_MAX_BYTES,
	checkMessageSize,
	createNativeHostManifest,
	HOST_TO_BROWSER_MAX_BYTES,
	sanitizeRendererPayload,
	windowsRegistryValue,
} from "./native-host.js";
export type {
	DaemonInfo,
	JsonRpcRequest,
	JsonRpcResponse,
	RequestMeta,
} from "./protocol.js";
export {
	completeResult,
	createDaemonInfo,
	discoveryResult,
	dispatchRequest,
	isDeprecatedMethod,
	PROTOCOL_VERSION,
	parseFrame,
	SUPPORTED_VERSIONS,
	serializeFrame,
} from "./protocol.js";
export {
	assertStdoutClean,
	isStdinClosed,
	logToStderr,
	MAX_FRAME_BYTES,
	splitFrames,
} from "./stdio.js";
