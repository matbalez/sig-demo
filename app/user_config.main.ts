// Copyright 2017 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from 'node:path';
import { app } from 'electron';

import { start } from './base_config.node.ts';
import config from './config.main.ts';
import * as Errors from '../ts/types/errors.std.ts';
import {
  SIG_DEMO_APP_NAME,
  createSigDemoStorageDirectory,
} from '../ts/util/sigDemoStorage.node.ts';

// Also separates the OS safeStorage/keychain identity in development builds.
app.setName(SIG_DEMO_APP_NAME);
let userData: string;
try {
  userData = createSigDemoStorageDirectory(
    app.getPath('appData'),
    config.get<unknown>('storageProfile'),
    config.has('storagePath') ? config.get<unknown>('storagePath') : undefined
  );
} catch (error) {
  // oxlint-disable-next-line no-console
  console.error(
    'Failed to create isolated sig demo data',
    Errors.toLogFormat(error)
  );
  throw error;
}
app.setPath('userData', userData);

// Use console.log because logger isn't fully initialized yet
// oxlint-disable-next-line no-console
console.log(`userData: ${app.getPath('userData')}`);

const userDataPath = app.getPath('userData');
const targetPath = join(userDataPath, 'config.json');

export const userConfig = start({
  name: 'user',
  targetPath,
  throwOnFilesystemErrors: true,
});

export const get = userConfig.get.bind(userConfig);
export const remove = userConfig.remove.bind(userConfig);
export const set = userConfig.set.bind(userConfig);
