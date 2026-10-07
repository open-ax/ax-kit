// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Installs the surface once for the whole file, before any test runs.
 *
 * `installModelContext` defines a non-configurable own property on the document,
 * so it is called exactly once here and every test shares the result. Each test
 * registers and removes its own tools instead.
 */

import { installModelContext } from "@ax-kit/core";

installModelContext(document);
