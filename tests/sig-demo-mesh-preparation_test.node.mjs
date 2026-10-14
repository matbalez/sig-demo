// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';

const stubs = new Map([
  [
    'electron',
    "export const app = { isPackaged: false, getPath: () => '/__sig_demo_test__' }",
  ],
  [
    'appRootDir.main.ts',
    "export const getAppRootDir = () => '/__sig_demo_test__'",
  ],
  ['log.std.ts', 'export const createLogger = () => ({ info() {} })'],
  [
    'sleep.std.ts',
    'export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))',
  ],
  [
    'assert.std.ts',
    'export const strictAssert = (value, message) => { if (!value) throw new Error(message) }',
  ],
  ['drop.std.ts', 'export const drop = promise => { promise.catch(() => {}) }'],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = [...stubs].find(
      ([name]) => specifier === name || specifier.endsWith(`/${name}`)
    )?.[1];
    if (source) {
      return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { SigDemoMesh } = await import('../app/SigDemoMesh.main.ts');
hooks.deregister();

const first = {
  baseUrl: 'http://127.0.0.1:9337/v1',
  model: 'first-model',
  targetNodeId: 'a'.repeat(64),
};
const second = {
  ...first,
  model: 'second-model',
  targetNodeId: 'b'.repeat(64),
};
const catalog = {
  data: [first, second].map(route => ({
    id: route.model,
    capabilities: ['text'],
    payment: {
      offers: [{ provider_id: route.targetNodeId, paid: false, local: false }],
    },
  })),
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => catalog });

try {
  await test('startup and foreground share one warmup and reuse a qualified route', async () => {
    const mesh = new SigDemoMesh();
    mesh.getInference = async () => first;
    const gate = Promise.withResolvers();
    let calls = 0;
    const background = mesh.prepareInference(async () => {
      calls += 1;
      await gate.promise;
    });
    const foreground = mesh.prepareInference(async () => {
      assert.fail('duplicate warmup');
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    gate.resolve();
    assert.deepEqual(await background, first);
    assert.deepEqual(await foreground, first);
    assert.deepEqual(
      await mesh.prepareInference(async () => {
        assert.fail('repeat warmup');
      }),
      first
    );
  });

  await test('a slow first host switches to a distinct free host before becoming ready', async () => {
    const mesh = new SigDemoMesh();
    let current = first;
    mesh.getInference = async () => current;
    const attempted = [];
    const result = await mesh.prepareInference(async route => {
      attempted.push(route.targetNodeId);
      if (route.targetNodeId === first.targetNodeId) {
        throw new Error('Synthetic warmup timeout');
      }
      current = route;
    });
    assert.deepEqual(attempted, [first.targetNodeId, second.targetNodeId]);
    assert.deepEqual(result, second);
    assert.deepEqual(
      await mesh.prepareInference(async () => {
        assert.fail('qualified alternate was not retained');
      }),
      second
    );
  });

  await test('exhausted warmups remain retryable and a different model needs its own warmup', async () => {
    const mesh = new SigDemoMesh();
    let current = first;
    mesh.getInference = async () => current;
    let calls = 0;
    await assert.rejects(
      mesh.prepareInference(async () => {
        calls += 1;
        throw new Error('Synthetic unavailable host');
      }),
      /No responsive mesh node/
    );
    assert.equal(calls, 2);
    assert.deepEqual(
      await mesh.prepareInference(async () => {
        calls += 1;
      }),
      first
    );
    current = { ...first, model: 'different-model' };
    assert.deepEqual(
      await mesh.prepareInference(async () => {
        calls += 1;
      }),
      current
    );
    assert.equal(calls, 4);
  });

  await test('stop prevents an outstanding warmup from qualifying a route', async () => {
    const mesh = new SigDemoMesh();
    mesh.getInference = async () => first;
    const gate = Promise.withResolvers();
    const pending = mesh.prepareInference(async () => gate.promise);
    await new Promise(resolve => setImmediate(resolve));
    mesh.stop();
    gate.resolve();
    await assert.rejects(pending, /The mesh was stopped/);
  });
} finally {
  globalThis.fetch = originalFetch;
}
