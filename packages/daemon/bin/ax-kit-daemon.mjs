#!/usr/bin/env node
// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

// Executable shim. The shebang lives here rather than in the bundle so the
// built artifact stays a plain ES module that a test can spawn directly.

import { main } from "../dist/main.mjs";

main();
