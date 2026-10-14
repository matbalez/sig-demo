// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';

const PAID_MODEL = 'Qwen3.6-27B-Q6_K';
const firstNode = 'a'.repeat(64);
const paidNode = 'b'.repeat(64);
const token = Buffer.from(JSON.stringify({ id: paidNode, addrs: [] })).toString(
  'base64url'
);
const state = {
  commands: [],
  writes: [],
  launches: [],
  requests: [],
  children: new Map(),
  installed: true,
  installationFails: false,
  healthGate: undefined,
};
globalThis.__sigMeshPaidTest = state;
const originalKill = process.kill;
const originalFetch = globalThis.fetch;
process.kill = (pid, signal) => {
  const child = state.children.get(Math.abs(pid));
  if (!child) {
    const error = new Error('No mock process');
    error.code = 'ESRCH';
    throw error;
  }
  if (signal !== 0) {
    child.signalCode = signal;
    state.children.delete(child.pid);
  }
  return true;
};

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
    "import { setImmediate } from 'node:timers'; export const sleep = () => new Promise(resolve => setImmediate(resolve))",
  ],
  [
    'assert.std.ts',
    'export const strictAssert = (value, message) => { if (!value) throw new Error(message) }',
  ],
  ['drop.std.ts', 'export const drop = promise => { promise.catch(() => {}) }'],
  ['node:fs', 'export const existsSync = () => true'],
  [
    'node:fs/promises',
    `export const mkdir = async () => {};
     export const rm = async () => {};
     export const writeFile = async (path, contents) => { globalThis.__sigMeshPaidTest.writes.push({path,contents}) };
     export const readFile = async path => {
       if (path.endsWith('mesh-paid.json')) return ${JSON.stringify(JSON.stringify({ inviteToken: token, model: PAID_MODEL }))};
       if (path.endsWith('plugin-install.json') && globalThis.__sigMeshPaidTest.installed) return JSON.stringify({name:'lexe-wallet',enabled:true,install_path:'/__sig_demo_test__/mesh/plugins/lexe-wallet'});
       throw new Error('Mock file missing');
     };`,
  ],
  [
    'node:net',
    "import { EventEmitter } from 'node:events'; export const createServer = () => { const server = new EventEmitter(); server.listen = (_port, _host, callback) => callback(); server.close = callback => callback(); return server }",
  ],
  [
    'node:child_process',
    `import { EventEmitter } from 'node:events';
     export const execFile = (binary, args, options, callback) => {
       if (typeof options === 'function') callback = options;
       const state = globalThis.__sigMeshPaidTest;
       state.commands.push({binary,args});
       if (binary.endsWith('pgrep')) { const error = new Error('No process'); error.code = 1; callback(error); return }
       if (args.includes('install') && state.installationFails) { callback(new Error('Mock download failed')); return }
       if (args.includes('install')) state.installed = true;
       callback(null, '', '');
     };
     export const spawn = (binary, args, options) => {
       const state = globalThis.__sigMeshPaidTest;
       const child = new EventEmitter();
       child.pid = 900000 + state.launches.length + 1;
       child.exitCode = null; child.signalCode = null;
       state.children.set(child.pid, child);
       state.launches.push({binary,args,options,child});
       return child;
     };`,
  ],
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

const catalog = {
  data: [
    {
      id: 'free-model',
      capabilities: ['text'],
      payment: {
        offers: [{ provider_id: firstNode, paid: false, local: false }],
      },
    },
    {
      id: PAID_MODEL,
      capabilities: ['text'],
      payment: {
        offers: [
          { provider_id: paidNode, paid: true, local: false },
          { provider_id: firstNode, paid: false, local: false },
        ],
      },
    },
    {
      id: 'wrong-paid-model',
      capabilities: ['text'],
      payment: {
        offers: [{ provider_id: firstNode, paid: true, local: false }],
      },
    },
  ],
};
const policy = (mode = 'free_only') => ({
  mode,
  daily_budget_msat: mode === 'automatic' ? 500000 : null,
  spent_today_msat: 0,
  remaining_daily_budget_msat: mode === 'automatic' ? 500000 : 0,
});
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/health')) {
    await state.healthGate?.promise;
    return { ok: true, json: async () => ({}) };
  }
  if (url.endsWith('/models')) {
    return { ok: true, json: async () => catalog };
  }
  if (url.endsWith('/api/discover')) {
    return { ok: true, json: async () => [] };
  }
  assert.ok(url.endsWith('/api/wallet'));
  const request = JSON.parse(options.body);
  state.requests.push(request);
  assert.equal(request.expected_directory, '/__sig_demo_test__/mesh/payments');
  assert.ok(state.children.has(request.expected_pid));
  let value;
  switch (request.command) {
    case 'policy':
      value = policy(request.value?.mode);
      break;
    case 'balance':
      value = { spendable_msat: 1234000, available_for_inference_msat: 500000 };
      break;
    case 'transactions':
      value = [
        {
          id: 'funding',
          payment_hash: 'c'.repeat(64),
          inbound: true,
          amount_msat: 1000000,
          fee_msat: 0,
          status: 'succeeded',
          created_at_ms: 1000,
          settled_at_ms: 2000,
        },
      ];
      break;
    case 'fund':
      value = {
        bolt11: 'lnbc123abc',
        payment_hash: 'c'.repeat(64),
        amount_msat: request.amount_msat,
        expires_at_ms: 1000000,
      };
      break;
    default:
      assert.fail('Unexpected wallet command');
  }
  return { ok: true, json: async () => value };
};

function reset() {
  state.commands = [];
  state.writes = [];
  state.launches = [];
  state.requests = [];
  state.children.clear();
  state.installed = true;
  state.installationFails = false;
  state.healthGate = undefined;
}

try {
  await test('paid mode joins only the private mesh and selects its exact paid model', async () => {
    reset();
    const mesh = new SigDemoMesh();
    const route = await mesh.getInference('mesh-llm-paid');
    assert.equal(route.model, PAID_MODEL);
    assert.equal(route.targetNodeId, paidNode);
    assert.equal(state.launches.length, 1);
    assert.ok(!state.launches[0].args.includes('--auto'));
    assert.ok(!state.launches[0].args.includes(token));
    assert.ok(
      state.writes.some(
        write =>
          write.path.endsWith('paid-invite.token') && write.contents === token
      )
    );
    const policies = state.requests.filter(
      request => request.command === 'policy'
    );
    assert.deepEqual(policies[0].value, {
      mode: 'automatic',
      daily_budget_msat: 500000,
    });
    assert.ok(!state.requests.some(request => request.command === 'balance'));
    assert.ok(!state.requests.some(request => request.command === 'fund'));
    await assert.rejects(
      mesh.prepareInference(async () =>
        assert.fail('Paid completion was warmed')
      ),
      /Only free mesh inference is warmed/
    );
    assert.equal((await mesh.getInference('mesh-llm-paid')).model, PAID_MODEL);
    assert.equal(state.launches.length, 1);
    mesh.stop();
  });

  await test('free mode excludes paid offers and switching resets spending policy', async () => {
    reset();
    const mesh = new SigDemoMesh();
    await mesh.getInference('mesh-llm-paid');
    const free = await mesh.getInference();
    assert.equal(free.targetNodeId, firstNode);
    assert.ok(state.launches[1].args.includes('--auto'));
    assert.deepEqual(state.requests.at(-1).value, {
      mode: 'free_only',
      daily_budget_msat: null,
    });
    await mesh.configure('chatgpt');
    assert.equal(state.launches.length, 2);
    assert.equal(state.requests.at(-1).value.mode, 'free_only');
    mesh.stop();
  });

  await test('ChatGPT startup installs the wallet without a network client or wallet provisioning', async () => {
    reset();
    state.installed = false;
    const mesh = new SigDemoMesh();
    await mesh.configure('chatgpt');
    assert.equal(state.launches.length, 0);
    assert.ok(
      state.commands.some(command =>
        command.args.includes('Mesh-LLM/lexe-wallet@v0.1.0')
      )
    );
    assert.ok(
      state.commands.some(command => command.args.includes('free-only'))
    );
    assert.equal(state.requests.length, 0);
    mesh.stop();
  });

  await test('an interrupted join cannot activate paid mode after a newer selection', async () => {
    reset();
    const mesh = new SigDemoMesh();
    state.healthGate = Promise.withResolvers();
    const paid = mesh.configure('mesh-llm-paid');
    const paidResult = assert.rejects(paid, /The mesh was stopped/);
    while (!state.launches.length) {
      // oxlint-disable-next-line no-await-in-loop -- Wait until the controlled join reaches its gate before switching.
      await new Promise(resolve => setImmediate(resolve));
    }
    const free = mesh.configure('mesh-llm');
    state.healthGate.resolve();
    await paidResult;
    await free;
    assert.equal(state.launches.length, 2);
    assert.ok(state.launches.at(-1).args.includes('--auto'));
    assert.ok(
      state.requests.every(request => request.value.mode === 'free_only')
    );
    mesh.stop();
  });

  await test('wallet commands target the owned process and funding is issued once', async () => {
    reset();
    const mesh = new SigDemoMesh();
    await mesh.configure('chatgpt');
    const snapshot = await mesh.getWalletSnapshot();
    assert.equal(snapshot.spendableMsat, 1234000);
    assert.equal(snapshot.transactions[0].paymentHash, 'c'.repeat(64));
    assert.equal(snapshot.transactions[0].settledAtMs, 2000);
    const invoice = await mesh.fundWallet(1000);
    assert.equal(invoice.amountMsat, 1000000);
    assert.equal(invoice.paymentHash, 'c'.repeat(64));
    assert.equal(
      state.requests.filter(request => request.command === 'fund').length,
      1
    );
    await assert.rejects(mesh.fundWallet(1.5), /could not create an invoice/);
    assert.equal(
      state.requests.filter(request => request.command === 'fund').length,
      1
    );
    mesh.stop();
  });

  await test('a plugin download failure keeps free inference available and paid setup retryable', async () => {
    reset();
    state.installed = false;
    state.installationFails = true;
    const mesh = new SigDemoMesh();
    const route = await mesh.getInference();
    assert.equal(route.targetNodeId, firstNode);
    assert.equal(state.requests.length, 0);
    assert.ok(
      state.writes.some(
        write =>
          write.path.endsWith('config.toml') &&
          write.contents.includes('name = "payments"\nenabled = false')
      )
    );
    await assert.rejects(
      mesh.configure('mesh-llm-paid'),
      /wallet could not be installed/
    );
    state.installationFails = false;
    await mesh.configure('mesh-llm-paid');
    assert.equal((await mesh.getInference('mesh-llm-paid')).model, PAID_MODEL);
    mesh.stop();
  });
} finally {
  process.kill = originalKill;
  globalThis.fetch = originalFetch;
  delete globalThis.__sigMeshPaidTest;
}
