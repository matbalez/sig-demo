// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import process from 'node:process';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';

const harnessKey = '__sigDemoPaidAgentTestHarness';
const freeRoute = {
  baseUrl: 'http://127.0.0.1:9337/v1',
  model: 'free-test-model',
  targetNodeId: 'a'.repeat(64),
};
const paidRoute = {
  ...freeRoute,
  model: 'Qwen3.6-27B-Q6_K',
  targetNodeId: 'b'.repeat(64),
};
const fakeBraveKey = 'brave-test-credential';
const fakeOpenAIKey = 'openai-test-credential-long-enough';
const requestId = '00000000-0000-4000-8000-000000000001';
const tick = () => new Promise(resolve => setImmediate(resolve));

const stubs = new Map([
  [
    'electron',
    `export const app = {
      isPackaged: false,
      on: (...args) => globalThis.${harnessKey}.appOn(...args),
    };
    export const ipcMain = {
      handle: (...args) => globalThis.${harnessKey}.handle(...args),
      on: (...args) => globalThis.${harnessKey}.on(...args),
    };`,
  ],
  [
    'node:fs',
    `export const existsSync = path => globalThis.${harnessKey}.exists(path);
     export const readFileSync = path => globalThis.${harnessKey}.read(path);`,
  ],
  [
    'node:child_process',
    `export const spawn = (...args) => globalThis.${harnessKey}.spawn(...args);`,
  ],
  [
    'appRootDir.main.ts',
    "export const getAppRootDir = () => '/__sig_demo_paid_agent_test__'",
  ],
  [
    'SigDemoMesh.main.ts',
    `export class SigDemoMesh {
      constructor() { globalThis.${harnessKey}.mesh = this; }
      configure(provider) { return globalThis.${harnessKey}.configure(provider); }
      getInference(provider) { return globalThis.${harnessKey}.getInference(provider); }
      prepareInference(warm) { return globalThis.${harnessKey}.prepareInference(warm); }
      getWalletSnapshot() { return globalThis.${harnessKey}.getWalletSnapshot(); }
      fundWallet(amount) { return globalThis.${harnessKey}.fundWallet(amount); }
      stop() { globalThis.${harnessKey}.record('mesh-stop'); }
    }`,
  ],
  ['log.std.ts', 'export const createLogger = () => ({ info() {} })'],
  ['drop.std.ts', 'export const drop = promise => { promise.catch(() => {}) }'],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Built-in stubs apply only to the integration under test. Other modules
    // retain their ordinary fs and child_process imports.
    if (
      specifier.startsWith('node:') &&
      !context.parentURL?.endsWith('/app/SigDemoAgent.main.ts')
    ) {
      return nextResolve(specifier, context);
    }
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
const { setupSigDemoAgent } = await import('../app/SigDemoAgent.main.ts');
hooks.deregister();

function createHarness() {
  const handlers = new Map();
  const listeners = new Map();
  const appListeners = new Map();
  const records = [];
  const reads = [];
  const spawns = [];
  const fundCalls = [];
  const events = [];
  const mainFrame = {};
  const sender = {
    mainFrame,
    isDestroyed: () => false,
    send: (channel, value) => events.push({ channel, value }),
  };
  const event = { sender, senderFrame: mainFrame };
  const snapshot = { spendableMsat: 0, transactions: [] };
  const invoice = {
    bolt11: 'synthetic-invoice-no-payment',
    paymentHash: 'c'.repeat(64),
    expiresAtMs: Date.now() + 60_000,
  };
  const harness = {
    handlers,
    listeners,
    records,
    reads,
    spawns,
    fundCalls,
    events,
    sender,
    event,
    snapshot,
    invoice,
    configureImpl: () => Promise.resolve(),
    inferenceImpl: async provider =>
      provider === 'mesh-llm-paid' ? paidRoute : freeRoute,
    prepareImpl: async () => freeRoute,
    fundImpl: async () => invoice,
    helperReply: true,
    record: (...value) => records.push(value),
    appOn: (name, callback) => appListeners.set(name, callback),
    handle: (name, callback) => handlers.set(name, callback),
    on: (name, callback) => listeners.set(name, callback),
    exists: () => true,
    read(path) {
      reads.push(path);
      if (path.endsWith('/.sig-demo/brave.env')) {
        return `BRAVE_SEARCH_API_KEY=${fakeBraveKey}\n`;
      }
      if (path.endsWith('/.sig-demo/agent.env')) {
        return `OPENAI_API_KEY=${fakeOpenAIKey}\n`;
      }
      assert.fail(`Unexpected credential or runtime read: ${path}`);
    },
    async configure(provider) {
      records.push(['configure', provider]);
      await harness.configureImpl(provider);
    },
    async getInference(provider) {
      records.push(['get-inference', provider]);
      return harness.inferenceImpl(provider);
    },
    async prepareInference(warm) {
      records.push(['prepare-inference']);
      return harness.prepareImpl(warm);
    },
    async getWalletSnapshot() {
      records.push(['wallet-snapshot']);
      return snapshot;
    },
    async fundWallet(amount) {
      fundCalls.push(amount);
      return harness.fundImpl(amount);
    },
    spawn(binary, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.input = '';
      child.killed = false;
      child.kill = () => {
        if (child.killed) {
          return true;
        }
        child.killed = true;
        records.push(['kill', spawns.indexOf(child)]);
        globalThis.queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      child.stdin = new Writable({
        write(chunk, encoding, callback) {
          child.input += chunk.toString();
          callback();
        },
        final(callback) {
          child.request = JSON.parse(child.input);
          if (harness.helperReply && child.request.mode !== 'warmup') {
            globalThis.queueMicrotask(() => {
              child.stdout.write(
                `${JSON.stringify({ type: 'text', text: '5' })}\n`
              );
              child.stdout.write(`${JSON.stringify({ type: 'done' })}\n`);
              child.stdout.end();
              child.emit('close', 0, null);
            });
          }
          callback();
        },
      });
      Object.assign(child, { binary, args, options });
      spawns.push(child);
      records.push(['spawn', spawns.length - 1]);
      return child;
    },
    invoke: (name, value, source = event) => handlers.get(name)(source, value),
    cleanup() {
      appListeners.get('before-quit')?.();
    },
  };
  globalThis[harnessKey] = harness;
  setupSigDemoAgent(() => sender);
  return harness;
}

const question = provider => ({
  requestId,
  provider,
  prompt: 'What is 2 + 3?',
  author: 'Alice',
  history: [{ role: 'user', author: 'Bob', text: 'We are doing arithmetic.' }],
});

// The runner has its own process. Synthetic ambient credentials verify that
// inherited keys are removed or replaced without using any real credential.
const ambientCredentials = new Map(
  ['OPENAI_API_KEY', 'BRAVE_SEARCH_API_KEY'].map(name => [
    name,
    process.env[name],
  ])
);
process.env.OPENAI_API_KEY = 'ambient-openai-test-key';
process.env.BRAVE_SEARCH_API_KEY = 'ambient-brave-test-key';

try {
  await test('paid provider configuration connects without invoking a GDK warmup', async () => {
    const harness = createHarness();
    try {
      assert.deepEqual(
        await harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid'),
        { ok: true }
      );
      await tick();
      assert.deepEqual(harness.records, [['configure', 'mesh-llm-paid']]);
      assert.equal(harness.spawns.length, 0);
      assert.equal(harness.reads.length, 0);
    } finally {
      harness.cleanup();
    }
  });

  await test('paid requests use the exact mesh route and Brave without loading OpenAI credentials', async () => {
    const harness = createHarness();
    try {
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid');
      assert.deepEqual(
        await harness.invoke('sig-demo-agent:start', question('mesh-llm-paid')),
        { ok: true }
      );
      await tick();
      assert.equal(harness.spawns.length, 1);
      const child = harness.spawns[0];
      assert.equal(child.request.provider, 'mesh-llm');
      assert.equal(child.request.mode, undefined);
      assert.equal(child.request.model, paidRoute.model);
      assert.equal(child.request.targetNodeId, paidRoute.targetNodeId);
      assert.equal(child.request.baseUrl, paidRoute.baseUrl);
      assert.equal(child.request.prompt, question('mesh-llm-paid').prompt);
      assert.deepEqual(
        child.request.history,
        question('mesh-llm-paid').history
      );
      assert.equal(child.options.env.OPENAI_API_KEY, undefined);
      assert.equal(child.options.env.BRAVE_SEARCH_API_KEY, fakeBraveKey);
      assert.deepEqual(harness.reads, [
        '/__sig_demo_paid_agent_test__/.sig-demo/brave.env',
      ]);
      assert.deepEqual(
        harness.records.filter(([name]) => name === 'get-inference'),
        [['get-inference', 'mesh-llm-paid']]
      );
      assert.ok(
        !harness.records.some(([name]) => name === 'prepare-inference')
      );
      assert.deepEqual(
        harness.events.map(({ value }) => value.type),
        ['status', 'text', 'done']
      );
    } finally {
      harness.cleanup();
    }
  });

  await test('ChatGPT retains its credential configuration and never loads Brave', async () => {
    const harness = createHarness();
    try {
      await harness.invoke('sig-demo-agent:configure', 'chatgpt');
      assert.deepEqual(
        await harness.invoke('sig-demo-agent:start', question('chatgpt')),
        { ok: true }
      );
      await tick();
      const child = harness.spawns[0];
      assert.equal(child.request.provider, 'chatgpt');
      assert.equal(child.request.targetNodeId, undefined);
      assert.equal(child.options.env.OPENAI_API_KEY, fakeOpenAIKey);
      assert.equal(child.options.env.BRAVE_SEARCH_API_KEY, undefined);
      assert.deepEqual(harness.reads, [
        '/__sig_demo_paid_agent_test__/.sig-demo/agent.env',
      ]);
      assert.ok(
        !harness.records.some(([name]) =>
          ['get-inference', 'prepare-inference'].includes(name)
        )
      );
    } finally {
      harness.cleanup();
    }
  });

  await test('wallet IPC only accepts the main renderer frame', async () => {
    const harness = createHarness();
    try {
      const sources = [
        { sender: { mainFrame: {} }, senderFrame: {} },
        { sender: harness.sender, senderFrame: {} },
      ];
      const responses = await Promise.all(
        sources.flatMap(source => [
          harness.invoke('sig-demo-wallet:snapshot', undefined, source),
          harness.invoke('sig-demo-wallet:fund', 1000, source),
          harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid', source),
        ])
      );
      for (const response of responses) {
        assert.equal(response.ok, false);
      }
      assert.equal(harness.records.length, 0);
      assert.equal(harness.fundCalls.length, 0);
      assert.deepEqual(await harness.invoke('sig-demo-wallet:snapshot'), {
        ok: true,
        value: harness.snapshot,
      });
    } finally {
      harness.cleanup();
    }
  });

  await test('funding requires a positive whole amount with safe milli-unit conversion', async () => {
    const harness = createHarness();
    try {
      const invalidAmounts = [
        0,
        -1,
        1.5,
        '1000',
        null,
        NaN,
        Infinity,
        Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1,
      ];
      const responses = await Promise.all(
        invalidAmounts.map(invalid =>
          harness.invoke('sig-demo-wallet:fund', invalid)
        )
      );
      for (const response of responses) {
        assert.equal(response.ok, false);
      }
      assert.equal(harness.fundCalls.length, 0);
      assert.deepEqual(await harness.invoke('sig-demo-wallet:fund', 1000), {
        ok: true,
        value: harness.invoice,
      });
      assert.deepEqual(harness.fundCalls, [1000]);
    } finally {
      harness.cleanup();
    }
  });

  await test('an uncertain invoice result is reported once and never retried automatically', async () => {
    const harness = createHarness();
    try {
      harness.fundImpl = async () => {
        throw new Error('Synthetic uncertain funding response');
      };
      const response = await harness.invoke('sig-demo-wallet:fund', 1000);
      assert.equal(response.ok, false);
      assert.match(response.error, /Refresh the wallet/);
      assert.ok(!response.error.includes('Synthetic'));
      await tick();
      assert.deepEqual(harness.fundCalls, [1000]);
    } finally {
      harness.cleanup();
    }
  });

  await test('switching to paid cancels a free warmup before changing the mesh policy', async () => {
    const harness = createHarness();
    try {
      harness.prepareImpl = async warm => {
        await warm(freeRoute);
        return freeRoute;
      };
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm');
      await tick();
      assert.equal(harness.spawns.length, 1);
      const warmChild = harness.spawns[0];
      assert.equal(warmChild.request.mode, 'warmup');
      assert.equal(warmChild.options.env.OPENAI_API_KEY, undefined);
      assert.equal(warmChild.options.env.BRAVE_SEARCH_API_KEY, undefined);
      assert.deepEqual(
        await harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid'),
        { ok: true }
      );
      await tick();
      assert.equal(warmChild.killed, true);
      const killedAt = harness.records.findIndex(([name]) => name === 'kill');
      const paidConfigureAt = harness.records.findIndex(
        ([name, provider]) =>
          name === 'configure' && provider === 'mesh-llm-paid'
      );
      assert.ok(killedAt >= 0 && killedAt < paidConfigureAt);
      assert.equal(harness.spawns.length, 1);
    } finally {
      harness.cleanup();
    }
  });

  await test('a delayed free warmup callback cannot spawn after switching to paid', async () => {
    const harness = createHarness();
    try {
      const gate = Promise.withResolvers();
      harness.prepareImpl = async warm => {
        await gate.promise;
        await warm(freeRoute);
        return freeRoute;
      };
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm');
      await tick();
      assert.equal(harness.spawns.length, 0);
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid');
      gate.resolve();
      await tick();
      assert.equal(harness.spawns.length, 0);
    } finally {
      harness.cleanup();
    }
  });

  await test('returning to free inference cannot revive a warmup from an older selection', async () => {
    const harness = createHarness();
    try {
      const gate = Promise.withResolvers();
      let preparations = 0;
      harness.prepareImpl = async warm => {
        preparations += 1;
        if (preparations === 1) {
          await gate.promise;
          await warm(freeRoute);
        }
        return freeRoute;
      };
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm');
      await tick();
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid');
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm');
      gate.resolve();
      await tick();
      assert.equal(preparations, 2);
      assert.equal(harness.spawns.length, 0);
    } finally {
      harness.cleanup();
    }
  });

  await test('a free request awaiting configuration cannot spawn after switching to paid', async () => {
    const harness = createHarness();
    try {
      const gate = Promise.withResolvers();
      harness.configureImpl = provider =>
        provider === 'mesh-llm' ? gate.promise : Promise.resolve();
      const stale = harness.invoke(
        'sig-demo-agent:start',
        question('mesh-llm')
      );
      await tick();
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid');
      gate.resolve();
      assert.equal((await stale).ok, false);
      assert.equal(harness.spawns.length, 0);
      assert.equal(harness.reads.length, 0);
      assert.ok(
        !harness.records.some(([name]) => name === 'prepare-inference')
      );
    } finally {
      harness.cleanup();
    }
  });

  await test('a paid route that arrives after a provider switch cannot launch a request', async () => {
    const harness = createHarness();
    try {
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid');
      const gate = Promise.withResolvers();
      harness.inferenceImpl = () => gate.promise;
      const stale = harness.invoke(
        'sig-demo-agent:start',
        question('mesh-llm-paid')
      );
      await tick();
      await harness.invoke('sig-demo-agent:configure', 'chatgpt');
      gate.resolve(paidRoute);
      assert.equal((await stale).ok, false);
      assert.equal(harness.spawns.length, 0);
      assert.equal(harness.events.length, 0);
    } finally {
      harness.cleanup();
    }
  });

  await test('an active paid helper stops before switching back to free inference', async () => {
    const harness = createHarness();
    try {
      harness.helperReply = false;
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm-paid');
      assert.equal(
        (
          await harness.invoke(
            'sig-demo-agent:start',
            question('mesh-llm-paid')
          )
        ).ok,
        true
      );
      const child = harness.spawns[0];
      await harness.invoke('sig-demo-agent:configure', 'mesh-llm');
      await tick();
      assert.equal(child.killed, true);
      const killedAt = harness.records.findIndex(([name]) => name === 'kill');
      const freeConfigureAt = harness.records.findIndex(
        ([name, provider]) => name === 'configure' && provider === 'mesh-llm'
      );
      assert.ok(killedAt >= 0 && killedAt < freeConfigureAt);
      assert.equal(harness.spawns.length, 1);
    } finally {
      harness.cleanup();
    }
  });
} finally {
  for (const [name, value] of ambientCredentials) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  delete globalThis[harnessKey];
}
