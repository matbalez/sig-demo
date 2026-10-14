// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
  parseSigDemoMeshBootstrapCache,
  selectSigDemoMeshBootstrapTokens,
  SIG_DEMO_MESH_BOOTSTRAP_CACHE_MAX_AGE,
} from '../ts/util/sigDemoMeshBootstrap.node.ts';

const now = 1_800_000_000_000;
const encode = value =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (character, relay = 'https://relay.example') =>
  encode({ id: character.repeat(64), addrs: [{ Relay: relay }] });
const advert = (character, overrides = {}) => ({
  listing: {
    invite_token: token(character),
    serving: ['text-model'],
    node_count: 1,
    client_count: 1,
    max_clients: 10,
    name: 'mesh-llm',
    mesh_id: 'public-mesh',
    ...overrides,
  },
  expires_at: now / 1000 + 600,
});

await test('cached bootstrap routes need freshness and distinct reachable endpoint hints', () => {
  const cache = { version: 1, savedAt: now, tokens: [token('a'), token('b')] };
  assert.deepEqual(parseSigDemoMeshBootstrapCache(cache, now), cache.tokens);
  for (const invalid of [
    null,
    { ...cache, version: 2 },
    { ...cache, savedAt: now + 1 },
    { ...cache, savedAt: now - SIG_DEMO_MESH_BOOTSTRAP_CACHE_MAX_AGE - 1 },
    { ...cache, tokens: [token('a')] },
    { ...cache, tokens: [token('a'), token('a', 'https://other.example')] },
    { ...cache, tokens: [token('a'), 'not-an-invite'] },
    {
      ...cache,
      tokens: [token('a'), encode({ id: 'b'.repeat(64), addrs: [] })],
    },
    {
      ...cache,
      tokens: [
        token('a'),
        encode({ bootstrap: { id: 'b'.repeat(64) }, secret: 'private' }),
      ],
    },
  ]) {
    assert.equal(parseSigDemoMeshBootstrapCache(invalid, now), undefined);
  }
});

await test('discovery candidates exclude expired, full, non-serving, and incompatible meshes', () => {
  const expired = { ...advert('b'), expires_at: now / 1000 };
  const inputs = [
    advert('a'),
    expired,
    advert('c', { client_count: 10 }),
    advert('d', { serving: [] }),
    advert('e', { node_count: 0 }),
    advert('f', { name: 'a private named mesh' }),
    advert('b', { mesh_id: 'another-mesh' }),
    advert('c', { invite_token: 'unusable' }),
    { token: token('d') },
  ];
  assert.deepEqual(
    selectSigDemoMeshBootstrapTokens(inputs, { now, meshId: 'public-mesh' }),
    [token('a')]
  );
  assert.deepEqual(
    selectSigDemoMeshBootstrapTokens({ token: token('a') }, { now }),
    []
  );
});

await test('known serving peers take priority without fixing the inference node', () => {
  const inputs = ['a', 'b', 'c', 'd', 'e'].map(character => advert(character));
  inputs.splice(
    1,
    0,
    advert('a', { invite_token: token('a', 'https://duplicate.example') })
  );
  assert.deepEqual(
    selectSigDemoMeshBootstrapTokens(inputs, {
      now,
      preferredNodeIds: ['e'.repeat(64), 'c'.repeat(64).toUpperCase()],
    }),
    [token('c'), token('e'), token('a'), token('b')]
  );
});
