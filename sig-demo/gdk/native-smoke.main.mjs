// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Run the actual SDK checks in Electron's app mode and close this test process.
import process from 'node:process';
import { app } from 'electron';

try {
  await import('./native-smoke.node.mjs');
} catch {
  process.stderr.write('The native GDK smoke could not start.\n');
  process.exitCode = 1;
} finally {
  app.exit(Number(process.exitCode ?? 0));
}
