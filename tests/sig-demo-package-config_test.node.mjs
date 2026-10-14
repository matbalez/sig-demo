// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { loadSigDemoPackageConfig } from '../scripts/sig-demo-package-config.mjs';

const LOCAL = 'https://localhost:14443';
const vpsConfig = {
  sigDemoEnabled: true,
  sigDemoNetworkMode: 'localhost',
  sigDemoRelay: { host: '51.159.213.86', port: 8443 },
  updatesEnabled: false,
  serverUrl: LOCAL,
  storageUrl: `${LOCAL}/storageService`,
  contentProxyUrl: `${LOCAL}/disabled`,
  updatesUrl: `${LOCAL}/disabled`,
  resourcesUrl: `${LOCAL}/updates2`,
  sfuUrl: `${LOCAL}/callingService`,
  challengeUrl: `${LOCAL}/disabled`,
  registrationChallengeUrl: `${LOCAL}/disabled`,
  cdn: { 0: LOCAL, 2: LOCAL, 3: `${LOCAL}/cdn3` },
  certificateAuthority:
    '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n',
  serverTrustRoots: ['private-demo-trust-root'],
  serverPublicParams: 'private-demo-group-parameters',
  genericServerPublicParams: 'private-demo-generic-parameters',
  backupServerPublicParams: 'private-demo-backup-parameters',
  storageProfile: 'other-demo-profile',
  storagePath: '/some/previous/demo/directory',
};

function withConfig(config, run) {
  const directory = mkdtempSync(join(tmpdir(), 'sig-demo-package-config-'));
  const path = join(directory, 'selected-backend.json');
  writeFileSync(path, JSON.stringify(config));
  try {
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('packaging requires explicit backend selection', () => {
  for (const path of [undefined, null, '', '   ']) {
    assert.throws(
      () => loadSigDemoPackageConfig(path),
      /requires --config FILE/
    );
  }
});

test('packager CLI rejects omitted backend selection before checking build prerequisites', () => {
  const script = fileURLToPath(
    new URL('../scripts/package-sig-demo.mjs', import.meta.url)
  );
  // An invalid architecture prevents any packaging if a future regression
  // reintroduces a default config. The missing-config guard must run first.
  const result = spawnSync(
    process.execPath,
    [script, '--arch', 'test-no-build'],
    { encoding: 'utf8', timeout: 5_000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires --config FILE/);
  assert.doesNotMatch(result.stderr, /currently targets macOS arm64/);
});

test('selected VPS configuration retains relay, endpoints, and trust while isolating storage', () => {
  withConfig(vpsConfig, path => {
    const packaged = loadSigDemoPackageConfig(path);
    const expected = { ...vpsConfig };
    delete expected.storagePath;
    assert.deepEqual(packaged, { ...expected, storageProfile: 'demo' });
    assert.equal(Object.hasOwn(packaged, 'storagePath'), false);
    assert.equal(vpsConfig.storageProfile, 'other-demo-profile');
    assert.equal(vpsConfig.storagePath, '/some/previous/demo/directory');
  });
});

test('an explicitly selected local backend remains available for local demos', () => {
  const local = { ...vpsConfig };
  delete local.sigDemoRelay;
  withConfig(local, path => {
    const packaged = loadSigDemoPackageConfig(path);
    assert.equal(packaged.serverUrl, LOCAL);
    assert.equal(Object.hasOwn(packaged, 'sigDemoRelay'), false);
    assert.equal(packaged.storageProfile, 'demo');
  });
});

test('packaging rejects upstream targets, enabled updates, and mismatched relay URLs', () => {
  for (const invalid of [
    { ...vpsConfig, serverUrl: 'https://chat.signal.org' },
    {
      ...vpsConfig,
      sigDemoRelay: { host: 'chat.signal.org', port: 443 },
    },
    { ...vpsConfig, updatesEnabled: true },
    { ...vpsConfig, storageUrl: 'https://localhost:8443/storageService' },
    {
      ...vpsConfig,
      cdn: { ...vpsConfig.cdn, 3: 'https://localhost:8443/cdn3' },
    },
  ]) {
    withConfig(invalid, path => {
      assert.throws(() => loadSigDemoPackageConfig(path));
    });
  }
});
