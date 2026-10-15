// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichSigDemoMeshNodeDetails } from '../ts/util/sigDemoMeshNodeDetails.std.ts';

const first = 'a'.repeat(64);
const other = 'b'.repeat(64);
const option = (nodeId, extra = {}) => ({
  id: JSON.stringify(['test-model', nodeId]),
  nodeId,
  model: 'test-model',
  available: true,
  paid: false,
  ...extra,
});

await test('unique peer prefixes enrich every model option for that full node', () => {
  const input = [
    option(first),
    option(first, { id: 'second-model', model: 'other' }),
    option(other),
  ];
  const result = enrichSigDemoMeshNodeDetails(input, {
    peers: [
      {
        id: first.slice(0, 10).toUpperCase(),
        hostname: ' worker.local ',
        version: '0.78.1',
        latency_ms: 87,
        rtt_ms: 195,
        gpus: [{ name: 'NVIDIA RTX 4090', rated_vram_gb: 24 }],
        release_attestation: { status: 'valid', verified: true },
        token: 'must-never-cross',
      },
    ],
    token: 'must-never-cross',
  });
  for (const enriched of result.slice(0, 2)) {
    assert.equal(enriched.hostname, 'worker.local');
    assert.equal(enriched.version, '0.78.1');
    assert.equal(enriched.latencyMs, 87);
    assert.equal(enriched.hardware, 'NVIDIA RTX 4090 (24 GB)');
    assert.equal(enriched.releaseAttestation, 'verified');
  }
  assert.equal(result[2], input[2]);
  assert.equal(input[0].hostname, undefined);
  assert.ok(!JSON.stringify(result).includes('must-never-cross'));
});

await test('ambiguous short prefixes and duplicate peer rows do not attach metadata', () => {
  const shared = `${first.slice(0, 10)}${'c'.repeat(54)}`;
  const input = [option(first), option(shared)];
  const peer = { id: first.slice(0, 10), hostname: 'ambiguous-host' };
  assert.deepEqual(
    enrichSigDemoMeshNodeDetails(input, { peers: [peer] }),
    input
  );
  const single = [option(first)];
  assert.deepEqual(
    enrichSigDemoMeshNodeDetails(single, { peers: [peer, peer] }),
    single
  );
});

await test('configured Phala labels and hardware remain authoritative, without a TEE claim', () => {
  const configured = option(first, {
    paid: true,
    hosting: 'phala',
    label: 'Phala H200',
    hardware: 'Intel TDX + NVIDIA H200 (operator checked)',
  });
  const [enriched] = enrichSigDemoMeshNodeDetails([configured], {
    peers: [
      {
        id: first.slice(0, 10),
        hostname: null,
        version: '0.78.1',
        rtt_ms: 90,
        gpus: [],
        release_attestation: { status: 'valid', verified: true },
        tee_verified: true,
      },
    ],
  });
  assert.equal(enriched.label, configured.label);
  assert.equal(enriched.hardware, configured.hardware);
  assert.equal(enriched.hosting, 'phala');
  assert.equal(enriched.hostname, undefined);
  assert.equal(enriched.latencyMs, 90);
  assert.equal(enriched.releaseAttestation, 'verified');
  assert.equal(enriched.tee_verified, undefined);
  const [hidden] = enrichSigDemoMeshNodeDetails([option(other)], {
    peers: [{ id: other.slice(0, 10), hostname: null, gpus: [] }],
  });
  assert.equal(hidden.hardware, undefined);
  assert.equal(hidden.releaseAttestation, 'unavailable');
});

await test('malformed metadata is omitted and missing status does not prevent model selection', () => {
  const input = [option(first)];
  for (const status of [
    null,
    [],
    {},
    { peers: null },
    { peers: [null, { id: 'not-a-peer' }] },
  ]) {
    assert.deepEqual(enrichSigDemoMeshNodeDetails(input, status), input);
  }
  const [enriched] = enrichSigDemoMeshNodeDetails(input, {
    peers: [
      {
        id: first,
        hostname: 'bad\u001bhostname',
        version: 'x'.repeat(65),
        latency_ms: Infinity,
        rtt_ms: -1,
        gpus: [{ name: 'bad\nGPU' }],
        release_attestation: { status: 'invalid', verified: false },
      },
    ],
  });
  assert.equal(enriched.hostname, undefined);
  assert.equal(enriched.version, undefined);
  assert.equal(enriched.latencyMs, undefined);
  assert.equal(enriched.hardware, undefined);
  assert.equal(enriched.releaseAttestation, 'unverified');
});
