// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { test } from 'node:test';
import {
  assertSigDemoNetworkConfig,
  assertSigDemoRelayConfig,
  getSigDemoLocalChatPort,
} from '../ts/util/sigDemoIsolation.std.ts';
import {
  resolveSigDemoStoragePath,
  createSigDemoStorageDirectory,
} from '../ts/util/sigDemoStorage.node.ts';

const CA = '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n';
const LOCAL = 'https://localhost:9999';
const localConfig = {
  sigDemoEnabled: true,
  sigDemoNetworkMode: 'localhost',
  updatesEnabled: false,
  certificateAuthority: CA,
  serverUrl: LOCAL,
  storageUrl: LOCAL,
  contentProxyUrl: LOCAL,
  updatesUrl: LOCAL,
  resourcesUrl: LOCAL,
  sfuUrl: LOCAL,
  challengeUrl: LOCAL,
  registrationChallengeUrl: LOCAL,
  cdn: { 0: LOCAL, 2: LOCAL, 3: LOCAL },
};

test('relay permits only the approved demo server and requires all URLs to use its local port', () => {
  assert.doesNotThrow(() =>
    assertSigDemoNetworkConfig({
      ...localConfig,
      sigDemoRelay: { host: '51.159.213.86', port: 8443 },
    })
  );
  for (const host of [
    'chat.signal.org',
    'chat.staging.signal.org',
    'example.com',
    '51.159.213.87',
  ]) {
    assert.throws(() => assertSigDemoRelayConfig({ host, port: 8443 }));
  }
  for (const port of [0, -1, 65536, 443.1, '8443', undefined]) {
    assert.throws(() =>
      assertSigDemoRelayConfig({ host: '51.159.213.86', port })
    );
  }
  assert.doesNotThrow(() =>
    assertSigDemoRelayConfig({ host: '127.0.0.1', port: 8443 })
  );
  for (const name of ['storageUrl', 'resourcesUrl', 'sfuUrl']) {
    assert.throws(() =>
      assertSigDemoNetworkConfig({
        ...localConfig,
        [name]: 'https://localhost:9998',
        sigDemoRelay: { host: '51.159.213.86', port: 8443 },
      })
    );
  }
  assert.throws(() =>
    assertSigDemoNetworkConfig({
      ...localConfig,
      cdn: { ...localConfig.cdn, 0: 'https://localhost:9998' },
      sigDemoRelay: { host: '51.159.213.86', port: 8443 },
    })
  );
});

test('local transport accepts only an explicit localhost TLS port and certificate', () => {
  assert.equal(getSigDemoLocalChatPort(LOCAL, CA), 9999);
  assert.doesNotThrow(() => assertSigDemoNetworkConfig(localConfig));
  for (const serverUrl of [
    'https://chat.signal.org',
    'https://chat.staging.signal.org',
    'https://private-demo.example:9999',
    'https://localhost',
    'https://localhost:0',
    'http://localhost:9999',
    'https://localhost:9999/path',
    'https://localhost:9999?server=production',
    'https://localhost:9999@chat.signal.org',
    'https://user:password@localhost:9999',
    'https://localhost.signal.org:9999',
  ]) {
    assert.throws(
      () => getSigDemoLocalChatPort(serverUrl, CA),
      undefined,
      serverUrl
    );
  }
  assert.throws(() => getSigDemoLocalChatPort(LOCAL, undefined));
  assert.throws(() => getSigDemoLocalChatPort(LOCAL, 'not a configured CA'));
});

test('existing symlinks cannot redirect demo directory creation into production data', () => {
  const appData = mkdtempSync(join(tmpdir(), 'sig-demo-storage-test-'));
  const production = join(appData, 'Signal');
  const demoRoot = join(appData, 'sig demo');
  mkdirSync(production);
  try {
    symlinkSync(production, demoRoot, 'dir');
    assert.throws(() => createSigDemoStorageDirectory(appData, 'demo'));
    assert.equal(existsSync(join(production, 'demo')), false);
    rmSync(demoRoot);
    mkdirSync(demoRoot);
    symlinkSync(production, join(demoRoot, 'alias'), 'dir');
    assert.throws(() =>
      createSigDemoStorageDirectory(
        appData,
        'demo',
        join(demoRoot, 'alias', 'nested-demo')
      )
    );
    assert.equal(existsSync(join(production, 'nested-demo')), false);
    const fresh = createSigDemoStorageDirectory(appData, 'fresh');
    assert.equal(fresh, join(demoRoot, 'fresh'));
    assert.equal(existsSync(fresh), true);
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test('network config blocks defaults, upstream overrides and enabling the updater', () => {
  assert.throws(() =>
    assertSigDemoNetworkConfig({ ...localConfig, sigDemoEnabled: false })
  );
  assert.throws(() =>
    assertSigDemoNetworkConfig({
      ...localConfig,
      sigDemoNetworkMode: 'blocked',
    })
  );
  assert.throws(() =>
    assertSigDemoNetworkConfig({ ...localConfig, updatesEnabled: true })
  );
  for (const name of [
    'serverUrl',
    'storageUrl',
    'contentProxyUrl',
    'updatesUrl',
    'resourcesUrl',
    'sfuUrl',
    'challengeUrl',
    'registrationChallengeUrl',
  ]) {
    assert.throws(
      () =>
        assertSigDemoNetworkConfig({
          ...localConfig,
          [name]: 'https://chat.signal.org',
        }),
      undefined,
      name
    );
  }
  assert.throws(() =>
    assertSigDemoNetworkConfig({
      ...localConfig,
      cdn: { ...localConfig.cdn, 2: 'https://cdn.signal.org' },
    })
  );
});

test('all shipped environments remain blocked instead of selecting Signal services', () => {
  const defaults = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url))
  );
  for (const env of [
    'development',
    'production',
    'staging',
    'test',
    'test-lib',
  ]) {
    const overrides = JSON.parse(
      readFileSync(new URL(`../config/${env}.json`, import.meta.url))
    );
    const merged = { ...defaults, ...overrides };
    assert.throws(() => assertSigDemoNetworkConfig(merged), undefined, env);
    assert.equal(merged.updatesEnabled, false);
    assert.equal(merged.serverUrl, 'https://sig-demo.invalid');
  }
});

test('storage is segregated from Signal and cannot escape via config paths', () => {
  const appData = '/tmp/application-support';
  const expectedRoot = '/tmp/application-support/sig demo';
  assert.deepEqual(resolveSigDemoStoragePath(appData, 'demo'), {
    root: expectedRoot,
    path: `${expectedRoot}/demo`,
  });
  assert.deepEqual(
    resolveSigDemoStoragePath(appData, 'alice', `${expectedRoot}/alice`),
    {
      root: expectedRoot,
      path: `${expectedRoot}/alice`,
    }
  );
  for (const profile of [
    '../Signal',
    '/Signal',
    '',
    'demo/../../Signal',
    undefined,
  ]) {
    assert.throws(() => resolveSigDemoStoragePath(appData, profile));
  }
  for (const path of [
    `${appData}/Signal`,
    `${appData}/Signal Beta`,
    '/tmp/other-app',
    expectedRoot,
    `${expectedRoot}/../Signal`,
    'relative-path',
  ]) {
    assert.throws(() => resolveSigDemoStoragePath(appData, 'demo', path));
  }
});

test('package install identity and URL handlers are distinct from production Signal', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url))
  );
  assert.equal(pkg.name, 'sig-demo');
  assert.equal(pkg.productName, 'sig demo');
  assert.equal(pkg.build.appId, 'dev.matbalez.sig-demo');
  assert.equal(pkg.build.protocols, undefined);
  for (const target of ['mac', 'win', 'linux']) {
    assert.deepEqual(pkg.build[target].publish, []);
  }
  const preconnect = readFileSync(
    new URL('../ts/textsecure/preconnect.preload.ts', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(preconnect, /Net\.Environment\.(Production|Staging)/);
  const main = readFileSync(
    new URL('../app/main.main.ts', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(main, /setAsDefaultProtocolClient\s*\(/);
});
