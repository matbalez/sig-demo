// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { WireCodec } from './codec.node.ts';
import { uniffiSchema } from './generated/schema.std.ts';

const codec = new WireCodec(uniffiSchema, {
  lowerObject() {
    throw new Error('This wire fixture must not reference native objects.');
  },
  liftObject() {
    throw new Error('This wire fixture must not reference native objects.');
  },
});

await test('UniFFI message fixture uses 1-based variants and UTF-8 byte lengths', () => {
  // The official generated Python binding uses role User=1, Text=1,
  // i32 big-endian lengths, and a UTF-8 byte count for nested strings.
  const bytes = Buffer.from('0000000100000001000000010000000368c3a9', 'hex');
  const message = { role: 'User', content: [{ kind: 'Text', text: 'hé' }] };
  assert.deepEqual(
    codec.decode({ kind: 'record', name: 'ProviderMessage' }, bytes),
    message
  );
  assert.deepEqual(
    codec.encode({ kind: 'record', name: 'ProviderMessage' }, message),
    bytes
  );
  assert.deepEqual(codec.encode({ kind: 'string' }, 'hé'), Buffer.from('hé'));
});

await test('SDK optional u64 error fields retain values beyond JavaScript safe integers', () => {
  const bytes = Buffer.from('0000000101010000000000000000000000', 'hex');
  assert.deepEqual(codec.decode({ kind: 'enum', name: 'GooseError' }, bytes), {
    kind: 'RateLimited',
    retryAfterMs: 72057594037927936n,
    retryAfterSuffix: '',
  });
  assert.throws(
    () => codec.encode({ kind: 'uint64' }, Number.MAX_SAFE_INTEGER + 1),
    TypeError
  );
});

await test('native tool and thinking metadata survive structured message serialization', () => {
  const original = {
    role: 'Assistant',
    content: [
      {
        kind: 'Thinking',
        thinking: 'hidden reasoning',
        signature: 'provider signature',
      },
      {
        kind: 'ToolRequest',
        id: 'call_1',
        name: 'brave_web_search',
        argumentsJson: '{"query":"recent news"}',
        providerMetadataJson: '{"signature":"opaque"}',
        toolErrorJson: null,
      },
    ],
  };
  const type = { kind: 'record', name: 'ProviderMessage' };
  assert.deepEqual(codec.decode(type, codec.encode(type, original)), original);
});

await test('malformed and truncated native data fail before partial wire values escape', () => {
  const type = { kind: 'enum', name: 'StreamChunk' };
  assert.throws(
    () => codec.decode(type, Buffer.from('00000001ffffffff', 'hex')),
    TypeError
  );
  assert.throws(
    () => codec.decode(type, Buffer.from('000000ff', 'hex')),
    TypeError
  );
  assert.throws(
    () =>
      codec.decode(
        { kind: 'optional', inner: { kind: 'string' } },
        Buffer.from([2])
      ),
    TypeError
  );
  assert.throws(
    () => codec.decode({ kind: 'uint64' }, Buffer.alloc(9)),
    TypeError
  );
});

await test('invalid model records fail during argument lowering without native invocation', () => {
  const type = { kind: 'record', name: 'ProviderModelConfig' };
  assert.throws(
    () => codec.encode(type, { modelName: 'demo', temperature: NaN }),
    TypeError
  );
  assert.throws(() => codec.encode(type, { maxTokens: 16 }), TypeError);
  assert.throws(
    () => codec.encode(type, { modelName: 'demo', timeoutMs: -1 }),
    RangeError
  );
});
