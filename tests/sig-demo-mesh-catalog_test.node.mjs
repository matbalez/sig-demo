// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getSigDemoMeshOptionId,
  parseSigDemoMeshCatalog,
  parseSigDemoMeshOptionId,
} from '../ts/util/sigDemoMeshCatalog.std.ts';

const freeNode = 'a'.repeat(64);
const paidNode = 'b'.repeat(64);

await test('catalog separates remote free and paid model/node pairs and describes actual advertised metadata', () => {
  const offer = { provider_id: freeNode, paid: false, local: false };
  const data = [
    {
      id: 'Qwen-model',
      capabilities: ['text', 'reasoning'],
      metadata: { context_length: 32768 },
      payment: {
        offers: [
          offer,
          offer,
          { ...offer, local: true },
          { provider_id: 'bad', paid: false, local: false },
          {
            provider_id: paidNode.toUpperCase(),
            paid: true,
            local: false,
            peer_last_seen_seconds_ago: 3,
            pricing: {
              input_msat_per_million: 1000,
              output_msat_per_million: 2000,
              minimum_invoice_msat: 500,
            },
          },
        ],
      },
    },
    {
      id: 'virtual',
      owned_by: 'plugin:agent',
      capabilities: ['text'],
      payment: { offers: [offer] },
    },
    {
      id: 'audio-only',
      capabilities: ['audio'],
      payment: { offers: [offer] },
    },
    {
      id: 'mesh',
      capabilities: ['text'],
      payment: { offers: [offer] },
    },
  ];
  const free = parseSigDemoMeshCatalog({ data }, false);
  assert.equal(free.length, 1);
  assert.equal(free[0].nodeId, freeNode);
  assert.equal(free[0].contextWindowTokens, 32768);
  assert.deepEqual(free[0].capabilities, ['text', 'reasoning']);
  const paid = parseSigDemoMeshCatalog({ data }, true);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].nodeId, paidNode);
  assert.equal(paid[0].lastSeenSecondsAgo, 3);
  assert.equal(paid[0].inputMsatPerMillionTokens, 1000);
  assert.equal(paid[0].outputMsatPerMillionTokens, 2000);
  assert.equal(paid[0].minimumInvoiceMsat, 500);
  assert.equal(paid[0].available, true);
});

await test('selection IDs roundtrip an exact model/node and reject alternate URLs or malformed targets', () => {
  const id = getSigDemoMeshOptionId('Qwen-model', paidNode.toUpperCase());
  assert.deepEqual(parseSigDemoMeshOptionId(id), {
    model: 'Qwen-model',
    nodeId: paidNode,
  });
  for (const value of [
    'http://example.test',
    '[]',
    JSON.stringify(['mesh', paidNode]),
    JSON.stringify(['model', 'not-a-node']),
    JSON.stringify(['model', paidNode, 'unexpected']),
  ]) {
    assert.equal(parseSigDemoMeshOptionId(value), undefined);
  }
});
