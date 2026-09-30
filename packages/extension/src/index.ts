// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Trusted-tier bridge driving `document.modelContext` from a service worker.
 *
 * Everything here is ours, not the draft's: the draft defines the
 * `document.modelContext` surface, while this entry holds the worker-side
 * transport, confirmation binding, manifest posture, and audit trail so no
 * spec-conformant core path can observe them.
 */

export type {
	HandlerName,
	InjectionRequest,
	TransportKind,
} from "./handlers.js";
export {
	assertHandlerName,
	createInjectionRequest,
	HANDLER_NAMES,
	isHandlerName,
	TRANSPORT_KIND,
} from "./handlers.js";
export type {
	ApprovalActivity,
	ApprovalDetails,
	ConfirmationSurface,
	HitlKey,
} from "./hitl.js";
export {
	ApprovalStore,
	CONFIRMATION_SURFACE,
	canonicalizeArgs,
	createHitlKey,
	hashArgs,
	hitlKeysEqual,
	hitlKeyToString,
} from "./hitl.js";
export type { ExternallyConnectable, ManifestPosture } from "./manifest.js";
export {
	assertLiveContext,
	assertManifestPosture,
	defaultManifestPosture,
	firefoxManifestPosture,
} from "./manifest.js";
export type {
	AllowListDecision,
	AuditEntry,
	AuthorizationInput,
	FrameToolView,
} from "./trusted-tier.js";
export {
	AUDIT_TRAIL_DISCLAIMER,
	applyArgAllowList,
	authorizeExecution,
	isExposedToCaller,
	validateFrameTool,
	WorkerAuditTrail,
} from "./trusted-tier.js";
