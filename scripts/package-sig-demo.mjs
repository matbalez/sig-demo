// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/package-sig-demo.mjs [--config FILE] [--arch arm64|x64]\nBuilds a local macOS .app with public private-server settings; no publishing or notarization.'
  );
  process.exit(0);
}
let configPath = resolve(root, '.sig-demo/client.json');
let arch = process.arch;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--config' && args[index + 1]) {
    configPath = resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === '--arch' && args[index + 1]) {
    arch = args[index + 1];
    index += 1;
  } else {
    throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
}
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
  throw new Error('This initial package script targets macOS arm64 or x64.');
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
// Share the runtime's fail-closed policy when baking the private server config.
const { assertSigDemoNetworkConfig } =
  // oxlint-disable-next-line signal-desktop/no-restricted-paths
  await import('../ts/util/sigDemoIsolation.std.ts');
assertSigDemoNetworkConfig(config);
config.storageProfile = 'demo';
delete config.storagePath;
const bakedPath = resolve(root, 'config/local-production.json');
const previous = existsSync(bakedPath) ? readFileSync(bakedPath) : undefined;
const buildMetadata = previous ? JSON.parse(previous.toString('utf8')) : {};
if (
  Object.keys(buildMetadata).some(
    key => !['buildCreation', 'buildExpiration'].includes(key)
  )
) {
  throw new Error(
    'Existing production config contains custom settings; refusing to overwrite it.'
  );
}
const builderPath = resolve(root, 'node_modules/electron-builder/cli.js');
// Build outside cloud-synced Documents folders, whose File Provider can recreate
// Finder metadata immediately after xattr cleanup and invalidate verification.
const buildRoot = mkdtempSync(join(tmpdir(), 'sig-demo-build-'));
let completed = false;
writeFileSync(
  bakedPath,
  `${JSON.stringify({ ...buildMetadata, ...config }, null, 2)}\n`,
  {
    mode: 0o600,
  }
);
try {
  const env = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    SIGNAL_ENV: 'production',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    process.execPath,
    [
      builderPath,
      '--mac',
      `--${arch}`,
      '--dir',
      '--publish',
      'never',
      `--config.directories.output=${buildRoot}`,
    ],
    { cwd: root, env, stdio: 'inherit' }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Packaging failed (${result.status ?? result.signal}).`);
  }
  const app = resolve(
    buildRoot,
    arch === 'arm64' ? 'mac-arm64' : 'mac',
    'sig demo.app'
  );
  // Finder metadata can prevent codesign from signing a freshly built bundle.
  // Clear attributes only inside this build output, never installed apps.
  const attributes = spawnSync('/usr/bin/xattr', ['-cr', app], {
    cwd: root,
    stdio: 'inherit',
  });
  if (attributes.error) {
    throw attributes.error;
  }
  if (attributes.status !== 0) {
    throw new Error('Failed to clean metadata from the built sig demo bundle.');
  }
  const signing = spawnSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', app],
    { cwd: root, stdio: 'inherit' }
  );
  if (signing.error) {
    throw signing.error;
  }
  if (signing.status !== 0) {
    throw new Error('Local ad-hoc signing failed.');
  }
  const verification = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', app],
    { cwd: root, stdio: 'inherit' }
  );
  if (verification.error) {
    throw verification.error;
  }
  if (verification.status !== 0) {
    throw new Error('Built sig demo code signature verification failed.');
  }
  const release = resolve(root, 'release');
  mkdirSync(release, { recursive: true });
  const zip = resolve(release, `sig-demo-macos-${arch}.zip`);
  const archive = spawnSync(
    '/usr/bin/ditto',
    [
      '--norsrc',
      '--noextattr',
      '--noqtn',
      '-c',
      '-k',
      '--keepParent',
      app,
      zip,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  if (archive.error) {
    throw archive.error;
  }
  if (archive.status !== 0) {
    throw new Error('Failed to create the shareable sig demo ZIP.');
  }
  const reviewApp = resolve(
    release,
    arch === 'arm64' ? 'mac-arm64' : 'mac',
    'sig demo.app'
  );
  const copy = spawnSync(
    '/usr/bin/ditto',
    ['--norsrc', '--noextattr', '--noqtn', app, reviewApp],
    { cwd: root, stdio: 'inherit' }
  );
  if (copy.error) {
    throw copy.error;
  }
  if (copy.status !== 0) {
    throw new Error('Failed to copy the built sig demo app into release.');
  }
  completed = true;
  console.log(`Signed sig demo: ${app}`);
  console.log(`Review copy: ${reviewApp}`);
  console.log(`Shareable ZIP: ${zip}`);
} finally {
  if (previous) {
    writeFileSync(bakedPath, previous);
  } else {
    unlinkSync(bakedPath);
  }
  if (!completed) {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}
