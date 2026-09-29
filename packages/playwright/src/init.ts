// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { installModelContext } from "@ax-kit/core";

// Page-side entry, bundled as a single self-contained file. It runs through
// the runner's init-script hook before any application script, so the typed
// surface exists before the first test navigation lands.
installModelContext(document);
