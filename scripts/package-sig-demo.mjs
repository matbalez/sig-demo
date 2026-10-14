// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import {
  existsSync,
  copyFileSync,
  lstatSync,
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
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/package-sig-demo.mjs [--config FILE] [--arch arm64] [--agent-key-file FILE] [--brave-key-file FILE] [--paid-mesh-config-file FILE]\nBuilds sig demo with its native GDK SDK, mesh-llm sidecar, and approved private demo configuration; no publishing or notarization.'
  );
  process.exit(0);
}
let configPath = resolve(root, '.sig-demo/client.json');
let arch = process.arch;
let agentKeyPath = resolve(root, '.sig-demo/agent.env');
let braveKeyPath = resolve(root, '.sig-demo/brave.env');
let paidMeshConfigPath = resolve(root, '.sig-demo/mesh-paid.json');
let paidMeshConfigRequired = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--config' && args[index + 1]) {
    configPath = resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === '--arch' && args[index + 1]) {
    arch = args[index + 1];
    index += 1;
  } else if (args[index] === '--agent-key-file' && args[index + 1]) {
    agentKeyPath = resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === '--brave-key-file' && args[index + 1]) {
    braveKeyPath = resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === '--paid-mesh-config-file' && args[index + 1]) {
    paidMeshConfigPath = resolve(args[index + 1]);
    paidMeshConfigRequired = true;
    index += 1;
  } else {
    throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
}
if (process.platform !== 'darwin' || arch !== 'arm64') {
  throw new Error(
    'The bundled mesh-llm release currently targets macOS arm64.'
  );
}
const meshRelease = JSON.parse(
  readFileSync(resolve(root, 'sig-demo/mesh/release.json'), 'utf8')
);
const meshResources = resolve(
  root,
  '.sig-demo/mesh',
  `v${meshRelease.version}`,
  'mesh-bundle'
);
if (!existsSync(resolve(meshResources, 'mesh-llm'))) {
  throw new Error(
    'Fetch the mesh sidecar first: node scripts/fetch-sig-demo-mesh.mjs'
  );
}
function assertOfficialMeshHost(path) {
  const checksum = createHash('sha256')
    .update(readFileSync(path))
    .digest('hex');
  if (checksum !== meshRelease.hostSha256) {
    throw new Error(
      'The mesh-llm host must retain its official release bytes and attestation.'
    );
  }
}
assertOfficialMeshHost(resolve(meshResources, 'mesh-llm'));
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
const gdkLibraryPath = resolve(
  root,
  'sig-demo/gdk/native/target/release/libgoose_sdk.dylib'
);
if (!existsSync(gdkLibraryPath)) {
  throw new Error(
    'Build the native GDK first: sh sig-demo/gdk/build-native.sh'
  );
}
if (
  !existsSync(agentKeyPath) ||
  !lstatSync(agentKeyPath).isFile() ||
  lstatSync(agentKeyPath).isSymbolicLink()
) {
  throw new Error('The approved Sig burner credential file is missing.');
}
// Keep the credential out of node-config, command arguments, and build logs.
const keyMatch = readFileSync(agentKeyPath, 'utf8').match(
  /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$/m
);
let apiKey = keyMatch?.[1] ?? '';
if (
  (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
  (apiKey.startsWith("'") && apiKey.endsWith("'"))
) {
  apiKey = apiKey.slice(1, -1);
}
if (!apiKey.startsWith('sk-') || /\s/.test(apiKey)) {
  throw new Error('The approved Sig burner credential file is unusable.');
}
if (
  !existsSync(braveKeyPath) ||
  !lstatSync(braveKeyPath).isFile() ||
  lstatSync(braveKeyPath).isSymbolicLink()
) {
  throw new Error('The approved Sig Brave credential file is missing.');
}
const braveKeyMatch = readFileSync(braveKeyPath, 'utf8').match(
  /^\s*(?:export\s+)?BRAVE_SEARCH_API_KEY\s*=\s*(.*?)\s*$/m
);
let braveApiKey = braveKeyMatch?.[1] ?? '';
if (
  (braveApiKey.startsWith('"') && braveApiKey.endsWith('"')) ||
  (braveApiKey.startsWith("'") && braveApiKey.endsWith("'"))
) {
  braveApiKey = braveApiKey.slice(1, -1);
}
if (
  !braveApiKey ||
  braveApiKey.length > 1024 ||
  !/^[\u0021-\u007e]+$/.test(braveApiKey)
) {
  throw new Error('The approved Sig Brave credential file is unusable.');
}
const gdkArchitecture = spawnSync('/usr/bin/lipo', ['-archs', gdkLibraryPath], {
  encoding: 'utf8',
});
if (
  gdkArchitecture.error ||
  gdkArchitecture.status !== 0 ||
  !gdkArchitecture.stdout.trim().split(/\s+/).includes(arch)
) {
  throw new Error(
    'The native GDK architecture does not match this Mac package.'
  );
}
// Build outside cloud-synced Documents folders, whose File Provider can recreate
// Finder metadata immediately after xattr cleanup and invalidate verification.
const buildRoot = mkdtempSync(join(tmpdir(), 'sig-demo-build-'));
const gdkResources = resolve(buildRoot, 'sig-demo-gdk');
mkdirSync(gdkResources, { mode: 0o700 });
copyFileSync(gdkLibraryPath, resolve(gdkResources, 'libgoose_sdk.dylib'));
for (const name of ['LICENSE', 'NOTICE', 'SIG_DEMO_PATCH.md']) {
  copyFileSync(
    resolve(root, 'sig-demo/gdk/native/vendor/goose-provider-types', name),
    resolve(gdkResources, `GDK-${name}`)
  );
}
writeFileSync(
  resolve(gdkResources, 'runtime.json'),
  `${JSON.stringify({ apiKey, braveApiKey, model: 'gpt-6-luna' })}\n`,
  { mode: 0o600 }
);
// The unlisted mesh invitation belongs only in private build resources. Never
// bake it into node-config (which is logged) or public source/generated assets.
let paidMeshResources;
if (existsSync(paidMeshConfigPath)) {
  if (
    !lstatSync(paidMeshConfigPath).isFile() ||
    lstatSync(paidMeshConfigPath).isSymbolicLink()
  ) {
    throw new Error('The private paid mesh configuration is unusable.');
  }
  const paid = JSON.parse(readFileSync(paidMeshConfigPath, 'utf8'));
  if (
    typeof paid.inviteToken !== 'string' ||
    !/^[a-zA-Z0-9_-]{20,16384}$/.test(paid.inviteToken) ||
    paid.model !== 'Qwen3.6-27B-Q6_K'
  ) {
    throw new Error('The private paid mesh configuration is unusable.');
  }
  paidMeshResources = resolve(buildRoot, 'paid-mesh.json');
  writeFileSync(
    paidMeshResources,
    `${JSON.stringify({ inviteToken: paid.inviteToken, model: paid.model })}\n`,
    { mode: 0o600 }
  );
} else if (paidMeshConfigRequired) {
  throw new Error('The private paid mesh configuration is missing.');
}
const builderConfigPath = resolve(buildRoot, 'builder-config.json');
// A supplied config file replaces package.json's build section. Copy every
// public build setting so the demo identity, icon, file list, and fuses survive.
const packageBuild = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8')
).build;
writeFileSync(
  builderConfigPath,
  `${JSON.stringify({
    ...packageBuild,
    directories: { ...packageBuild.directories, output: buildRoot },
    extraResources: [
      ...(packageBuild.extraResources ?? []),
      { from: gdkResources, to: 'sig-demo-gdk' },
      { from: meshResources, to: 'sig-demo-mesh' },
      ...(paidMeshResources
        ? [{ from: paidMeshResources, to: 'sig-demo-mesh/paid.json' }]
        : []),
      {
        from: resolve(root, 'sig-demo/mesh/LICENSE'),
        to: 'sig-demo-mesh/LICENSE',
      },
    ],
  })}\n`
);
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
      `--config=${builderConfigPath}`,
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
  // The SDK dylib lives in Resources and is loaded through UniFFI. Sign it
  // explicitly before sealing the app, including any install-name changes.
  const nativeSigning = spawnSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      '-',
      resolve(app, 'Contents/Resources/sig-demo-gdk/libgoose_sdk.dylib'),
    ],
    { cwd: root, stdio: 'inherit' }
  );
  if (nativeSigning.error || nativeSigning.status !== 0) {
    throw new Error('Native GDK signing failed.');
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
  assertOfficialMeshHost(
    resolve(app, 'Contents/Resources/sig-demo-mesh/mesh-llm')
  );
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
