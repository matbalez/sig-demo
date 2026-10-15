// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
  parseSigDemoPaidMeshConfig,
  serializeSigDemoPaidMeshConfig,
} from '../ts/util/sigDemoMeshPaidConfig.std.ts';

const node = 'a'.repeat(64);
const other = 'b'.repeat(64);
const invitation = Buffer.from(
  JSON.stringify({ id: node, addrs: [] })
).toString('base64url');
const legacy = { inviteToken: invitation, model: 'Qwen3.6-27B-Q6_K' };

await test('legacy paid configuration retains optional identity pin behavior', () => {
  assert.deepEqual(parseSigDemoPaidMeshConfig(legacy), {
    nodes: [{ ...legacy, id: 'paid-node-1' }],
  });
  const pinned = parseSigDemoPaidMeshConfig({
    ...legacy,
    expectedNodeId: node.toUpperCase(),
  });
  assert.equal(pinned.nodes[0].expectedNodeId, node);
});

await test('packaging roundtrips an unpinned legacy node without making it an invalid collection', () => {
  const parsed = parseSigDemoPaidMeshConfig(legacy);
  const packaged = JSON.parse(serializeSigDemoPaidMeshConfig(parsed));
  assert.equal(packaged.inviteToken, invitation);
  assert.equal(packaged.nodes, undefined);
  assert.equal(packaged.expectedNodeId, undefined);
  assert.deepEqual(parseSigDemoPaidMeshConfig(packaged), parsed);
});

await test('multiple paid nodes preserve private bootstrap data and normalize the default mesh key', () => {
  const parsed = parseSigDemoPaidMeshConfig({
    defaultNodeId: node.toUpperCase(),
    nodes: [
      {
        ...legacy,
        id: 'phala',
        label: 'Phala H200',
        expectedNodeId: node.toUpperCase(),
        hosting: 'phala',
        hardware: 'Intel TDX + NVIDIA H200',
      },
      { ...legacy, expectedNodeId: other },
    ],
  });
  assert.equal(parsed.defaultNodeId, node);
  assert.equal(parsed.nodes[0].id, 'phala');
  assert.equal(parsed.nodes[0].expectedNodeId, node);
  assert.equal(parsed.nodes[0].hosting, 'phala');
  assert.equal(parsed.nodes[1].id, 'paid-node-2');
  assert.equal(parsed.nodes[0].inviteToken, invitation);
  assert.equal(serializeSigDemoPaidMeshConfig(parsed), JSON.stringify(parsed));
  assert.deepEqual(
    parseSigDemoPaidMeshConfig(
      JSON.parse(serializeSigDemoPaidMeshConfig(parsed))
    ),
    parsed
  );
});

await test('multi-node configuration requires explicit valid pins and a matching default', () => {
  for (const expectedNodeId of [
    '',
    'a'.repeat(63),
    'g'.repeat(64),
    null,
    undefined,
  ]) {
    assert.throws(() =>
      parseSigDemoPaidMeshConfig({ nodes: [{ ...legacy, expectedNodeId }] })
    );
  }
  assert.throws(() =>
    parseSigDemoPaidMeshConfig({
      defaultNodeId: other,
      nodes: [{ ...legacy, expectedNodeId: node }],
    })
  );
  assert.throws(() =>
    parseSigDemoPaidMeshConfig({
      nodes: [
        { ...legacy, id: 'same', expectedNodeId: node },
        { ...legacy, id: 'same', expectedNodeId: other },
      ],
    })
  );
});

await test('configuration failures expose fixed diagnostics and reject unverified trust flags', () => {
  for (const value of [
    { ...legacy, expectedNodeId: 'malformed-private-marker' },
    { nodes: [{ ...legacy, expectedNodeId: node, attestationVerified: true }] },
    { ...legacy, model: 'bad\nmodel' },
    { ...legacy, inviteToken: 'private marker with spaces' },
  ]) {
    assert.throws(
      () => parseSigDemoPaidMeshConfig(value),
      error =>
        error.message === 'The private paid mesh configuration is unusable.' &&
        !error.message.includes('private marker')
    );
  }
});
