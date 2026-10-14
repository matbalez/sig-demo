// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const release = JSON.parse(
  readFileSync(resolve(root, 'sig-demo/mesh/release.json'), 'utf8')
);
if (
  process.platform !== release.platform ||
  process.arch !== release.architecture
) {
  throw new Error(
    'The bundled mesh-llm release currently targets Apple Silicon Macs.'
  );
}
const directory = resolve(root, '.sig-demo/mesh', `v${release.version}`);
mkdirSync(directory, { recursive: true });
const archive = resolve(directory, release.asset);
const checksum = data => createHash('sha256').update(data).digest('hex');
if (
  !existsSync(archive) ||
  checksum(readFileSync(archive)) !== release.sha256
) {
  console.log(
    `Downloading official mesh-llm ${release.version} macOS release…`
  );
  const response = await fetch(release.url);
  if (!response.ok) {
    throw new Error(`mesh-llm download failed (${response.status}).`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (checksum(data) !== release.sha256) {
    throw new Error(
      'The downloaded mesh-llm archive did not match its pinned checksum.'
    );
  }
  writeFileSync(archive, data);
}
const bundle = resolve(directory, 'mesh-bundle');
const binary = resolve(bundle, 'mesh-llm');
if (
  !existsSync(binary) ||
  checksum(readFileSync(binary)) !== release.hostSha256
) {
  const result = spawnSync('/usr/bin/tar', ['-xzf', archive, '-C', directory], {
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error('Could not unpack the verified mesh-llm bundle.');
  }
}
if (checksum(readFileSync(binary)) !== release.hostSha256) {
  throw new Error(
    'The extracted mesh-llm host did not match its pinned checksum.'
  );
}
const manifest = JSON.parse(
  readFileSync(resolve(bundle, 'product-manifest.json'), 'utf8')
);
if (manifest.mesh_version !== release.version) {
  throw new Error(
    'The mesh-llm product manifest has the wrong release version.'
  );
}
console.log(`Verified mesh-llm ${release.version}: ${bundle}`);
