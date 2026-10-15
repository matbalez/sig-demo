// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readLocalJson,
  safeAgentEvents,
  safeMeshSnapshot,
  safeProcessAges,
} from '../scripts/collect-sig-demo-diagnostics.mjs';

test('incident capture rejects active probes, inference, wallet and control routes', () => {
  for (const path of [
    '/api/diagnostics/network',
    '/api/discover',
    '/api/wallet',
    '/v1/chat/completions',
    'https://example.test/',
    '/api/status?token=private',
  ]) {
    assert.throws(() => readLocalJson(path), /Only read-only/);
  }
});

test('incident snapshot retains counters and process age without private fields', () => {
  const privateValue = 'private-credential-do-not-copy';
  const status = {
    version: '0.78.1',
    node_id: 'a'.repeat(64),
    is_client: true,
    token: privateValue,
    mesh_id: privateValue,
    local_instances: [
      {
        is_self: true,
        pid: 123,
        api_port: 3131,
        started_at_unix: 1000,
        runtime_dir: privateValue,
      },
    ],
    peers: [
      {
        id: 'b'.repeat(64),
        hostname: privateValue,
        endpoint: privateValue,
        latency_source: 'direct',
        latency_ms: 8,
      },
    ],
    routing_metrics: {
      request_count: 5,
      successful_requests: 4,
      attempt_unavailable_count: 1,
      raw_error: privateValue,
    },
  };
  const models = {
    mesh_models: [
      {
        name: 'Qwen3.6-27B-Q6_K',
        routing_metrics: {
          targets: [
            { target: 'b'.repeat(64), attempt_count: 5, unavailable_count: 1 },
            { target: `https://${privateValue}.test/`, attempt_count: 1 },
          ],
        },
      },
      { name: `https://${privateValue}.test/` },
    ],
  };
  const result = safeMeshSnapshot({}, status, models, 1123, {
    peers: [
      {
        peer_id: 'b'.repeat(64),
        last_seen_secs_ago: 3,
        endpoint: privateValue,
      },
    ],
  });
  assert.equal(result.processes[0].ageSeconds, 123);
  assert.equal(result.metrics.attempt_unavailable_count, 1);
  assert.equal(result.models[0].targets[0].node, 'b'.repeat(10));
  assert.equal(result.peerFreshness[0].last_seen_secs_ago, 3);
  const output = JSON.stringify(result);
  assert.ok(!output.includes(privateValue));
  assert.ok(!output.includes('b'.repeat(64)));
  assert.ok(!output.includes('runtime_dir'));
  assert.ok(!output.includes('token'));
});

test('only recognized agent log fields survive snapshot capture', () => {
  const privateValue = 'sk-private-chat-or-key-do-not-copy';
  const line = message =>
    JSON.stringify({ time: '2026-10-15T21:21:39.638Z', msg: message });
  const text = [
    line(`[other-service] ${privateValue}`),
    line(
      '[SigDemoAgent] Inference request failed ' +
        JSON.stringify({
          provider: 'mesh-llm-paid',
          errorCode: 'server-error',
          phase: 'model-turn',
          reasonCode: 'mesh-routes-exhausted',
          diagnosticId: '1a48258c',
          httpStatus: 503,
          model: 'Qwen3.6-27B-Q6_K',
          nodeId: 'a'.repeat(64),
          prompt: privateValue,
          requestId: privateValue,
          message: privateValue,
          totalMs: 10782,
        })
    ),
    line(
      '[SigDemoAgent] Inference request failed ' +
        JSON.stringify({
          provider: privateValue,
          errorCode: privateValue,
          diagnosticId: privateValue,
          model: privateValue,
        })
    ),
    '{partial',
  ].join('\n');
  const result = safeAgentEvents(text);
  assert.equal(result.length, 2);
  assert.equal(result[0].reference, '1a48258c');
  assert.equal(result[0].httpStatus, 503);
  assert.equal(result[0].phase, 'model-turn');
  assert.equal(result[0].reason, 'mesh-routes-exhausted');
  assert.equal(result[0].totalMs, 10782);
  assert.ok(!JSON.stringify(result).includes(privateValue));
});

test('process ages handle long uptime and unknown API start times', () => {
  const rows = safeProcessAges(
    ' 123 2-01:02:03 /Users/private/Applications/sig demo.app/Contents/MacOS/sig demo\n 456 05:06 /Users/private/Applications/sig demo.app/Contents/Resources/sig-demo-mesh/mesh-llm\n 789 00:03 /some/private/other-app'
  );
  assert.deepEqual(rows, [
    { kind: 'app', pid: 123, ageSeconds: 176523 },
    { kind: 'mesh', pid: 456, ageSeconds: 306 },
  ]);
  const mesh = safeMeshSnapshot(
    {},
    { local_instances: [{ is_self: true, started_at_unix: 0 }] },
    {},
    1792100000
  );
  assert.equal(mesh.processes[0].ageSeconds, undefined);
  assert.ok(!JSON.stringify(rows).includes('private'));
});
