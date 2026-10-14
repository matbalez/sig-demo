// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { app } from 'electron';

import { createLogger } from '../ts/logging/log.std.ts';
import * as GlobalErrors from './global_errors.main.ts';

const log = createLogger('startup_config');

GlobalErrors.addHandler();

// Set umask early on in the process lifecycle to ensure file permissions are
// set such that only we have read access to our files
process.umask(0o077);

// electron-builder removes development-only build settings from package.json.
export const AUMID = 'dev.matbalez.sig-demo';
log.info('Set Windows Application User Model ID (AUMID)', {
  AUMID,
});
app.setAppUserModelId(AUMID);
