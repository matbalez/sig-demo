// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';

export const SIG_DEMO_APP_NAME = 'sig demo';

export function resolveSigDemoStoragePath(
  appData: string,
  storageProfile: unknown,
  storagePath?: unknown
): { root: string; path: string } {
  const root = resolve(appData, SIG_DEMO_APP_NAME);
  if (
    typeof storageProfile !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(storageProfile)
  ) {
    throw new Error('sig demo requires a simple, distinct storage profile.');
  }
  let path = '';
  if (storagePath === undefined) {
    path = join(root, storageProfile);
  } else if (typeof storagePath === 'string' && isAbsolute(storagePath)) {
    path = resolve(storagePath);
  }
  const fromRoot = relative(root, path);
  if (
    path === '' ||
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      'sig demo data must stay inside its own application directory.'
    );
  }
  return { root, path };
}

export function createSigDemoStorageDirectory(
  appData: string,
  storageProfile: unknown,
  storagePath?: unknown
): string {
  const { root, path } = resolveSigDemoStoragePath(
    appData,
    storageProfile,
    storagePath
  );
  mkdirSync(root, { recursive: true });
  if (realpathSync(root) !== join(realpathSync(appData), SIG_DEMO_APP_NAME)) {
    throw new Error('sig demo application directory must not be a symlink.');
  }
  let ancestor = root;
  // Check existing ancestors before mkdir could follow a link into Signal's data.
  for (const component of relative(root, path).split(sep)) {
    ancestor = join(ancestor, component);
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('sig demo storage path must not contain a symlink.');
    }
  }
  mkdirSync(path, { recursive: true });
  const fromRoot = relative(realpathSync(root), realpathSync(path));
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      'sig demo storage path must not escape its application directory.'
    );
  }
  return path;
}
