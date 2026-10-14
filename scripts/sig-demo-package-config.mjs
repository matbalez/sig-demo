// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
// oxlint-disable-next-line signal-desktop/no-restricted-paths -- Packaging must enforce the same network policy as the app.
import { assertSigDemoNetworkConfig } from '../ts/util/sigDemoIsolation.std.ts';

/** Select the public backend configuration explicitly before packaging. */
export function loadSigDemoPackageConfig(configPath) {
  if (typeof configPath !== 'string' || configPath.trim() === '') {
    throw new Error(
      'Packaging requires --config FILE for the intended private backend.'
    );
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // Reuse the runtime isolation policy rather than accepting broader targets
  // merely because this configuration is being baked into an app bundle.
  assertSigDemoNetworkConfig(config);
  config.storageProfile = 'demo';
  delete config.storagePath;
  return config;
}
