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
const otherPaidNode = 'c'.repeat(64);
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
  paidConfig: { inviteToken: token, model: PAID_MODEL },
  catalog: undefined,
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
  ['node:crypto', 'export const randomInt = () => 0'],
  ['node:fs', 'export const existsSync = () => true'],
  [
    'node:fs/promises',
    `export const mkdir = async () => {};
     export const rm = async () => {};
     export const writeFile = async (path, contents) => { globalThis.__sigMeshPaidTest.writes.push({path,contents}) };
     export const readFile = async path => {
       if (path.endsWith('mesh-paid.json')) return JSON.stringify(globalThis.__sigMeshPaidTest.paidConfig);
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
const { getSigDemoMeshOptionId } =
  await import('../ts/util/sigDemoMeshCatalog.std.ts');

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
    return { ok: true, json: async () => state.catalog };
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
  state.paidConfig = { inviteToken: token, model: PAID_MODEL };
  state.catalog = globalThis.structuredClone(catalog);
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

  await test('a paid node pin excludes other nodes offering the same paid model', async () => {
    reset();
    state.paidConfig.expectedNodeId = paidNode.toUpperCase();
    state.catalog.data[1].payment.offers.unshift({
      provider_id: otherPaidNode,
      paid: true,
      local: false,
    });
    const mesh = new SigDemoMesh();
    const route = await mesh.getInference('mesh-llm-paid');
    assert.equal(route.model, PAID_MODEL);
    assert.equal(route.targetNodeId, paidNode);
    // A paid-only pin must not restrict the existing free selection flow.
    assert.equal((await mesh.getInference()).targetNodeId, firstNode);
    mesh.stop();
  });

  await test('an absent pinned paid node fails without selecting another matching offer', async () => {
    reset();
    state.paidConfig.expectedNodeId = paidNode;
    state.catalog.data[1].payment.offers = [
      { provider_id: otherPaidNode, paid: true, local: false },
    ];
    const mesh = new SigDemoMesh();
    await mesh.configure('mesh-llm-paid');
    const originalNow = Date.now;
    let now = originalNow();
    // Advance only the route polling deadline; no real 30-second wait is needed.
    Date.now = () => {
      now += 10_000;
      return now;
    };
    try {
      await assert.rejects(
        mesh.getInference('mesh-llm-paid'),
        /The paid mesh model is unavailable/
      );
      assert.equal(state.launches.length, 1);
      assert.ok(!state.launches[0].args.includes('--auto'));
    } finally {
      Date.now = originalNow;
      mesh.stop();
    }
  });

  await test('a malformed paid node pin rejects configuration before launching a client', async () => {
    for (const expectedNodeId of ['', 'b'.repeat(63), 'g'.repeat(64), null]) {
      reset();
      state.paidConfig.expectedNodeId = expectedNodeId;
      const mesh = new SigDemoMesh();
      // oxlint-disable-next-line no-await-in-loop -- Each isolated configuration must finish before resetting its mock state.
      await assert.rejects(
        mesh.configure('mesh-llm-paid'),
        /The private paid mesh is not configured/
      );
      assert.equal(state.launches.length, 0);
      mesh.stop();
    }
  });

  await test('explicit free model/node selection persists and catalog refresh never warms or changes policy', async () => {
    reset();
    const secondFree = 'd'.repeat(64);
    state.catalog.data[0].payment.offers.push({
      provider_id: secondFree,
      paid: false,
      local: false,
    });
    const mesh = new SigDemoMesh();
    const choice = getSigDemoMeshOptionId('free-model', secondFree);
    assert.equal(
      (await mesh.getInference('mesh-llm', choice)).targetNodeId,
      secondFree
    );
    assert.equal((await mesh.getInference()).targetNodeId, secondFree);
    const policies = state.requests.length;
    const launches = state.launches.length;
    const listed = await mesh.getInferenceOptions('mesh-llm');
    assert.equal(listed.selectionId, choice);
    assert.equal(listed.activeId, choice);
    assert.equal(listed.options.length, 3);
    assert.ok(listed.options.every(option => !option.paid));
    assert.equal(state.requests.length, policies);
    assert.equal(state.launches.length, launches);
    let warmups = 0;
    await assert.rejects(
      mesh.prepareInference(async route => {
        warmups += 1;
        assert.equal(route.targetNodeId, secondFree);
        throw new Error('Synthetic unavailable chosen node');
      }, choice),
      /No responsive mesh node/
    );
    assert.equal(warmups, 1);
    assert.equal(
      (await mesh.getInference('mesh-llm', '')).targetNodeId,
      firstNode
    );
    mesh.stop();
  });

  await test('multiple configured paid nodes default to their pin and a live explicit peer reuses the joined mesh', async () => {
    reset();
    const otherToken = Buffer.from(
      JSON.stringify({ id: otherPaidNode, addrs: [] })
    ).toString('base64url');
    state.paidConfig = {
      defaultNodeId: otherPaidNode,
      nodes: [
        {
          id: 'legacy',
          inviteToken: token,
          model: PAID_MODEL,
          expectedNodeId: paidNode,
          label: 'Legacy',
        },
        {
          id: 'phala',
          inviteToken: otherToken,
          model: PAID_MODEL,
          expectedNodeId: otherPaidNode,
          label: 'Phala GPU',
          hosting: 'phala',
          hardware: 'H200',
        },
      ],
    };
    state.catalog.data[1].payment.offers.push({
      provider_id: otherPaidNode,
      paid: true,
      local: false,
    });
    const mesh = new SigDemoMesh();
    await mesh.configure('mesh-llm-paid', '');
    assert.equal(
      (await mesh.getInferenceOptions('mesh-llm-paid')).activeId,
      getSigDemoMeshOptionId(PAID_MODEL, otherPaidNode)
    );
    assert.equal(
      (await mesh.getInference('mesh-llm-paid')).targetNodeId,
      otherPaidNode
    );
    const listed = await mesh.getInferenceOptions('mesh-llm-paid');
    assert.equal(
      listed.options.find(option => option.nodeId === otherPaidNode).hosting,
      'phala'
    );
    assert.ok(!JSON.stringify(listed).includes(token));
    assert.ok(!JSON.stringify(listed).includes(otherToken));
    const choice = getSigDemoMeshOptionId(PAID_MODEL, paidNode);
    assert.equal(
      (await mesh.getInference('mesh-llm-paid', choice)).targetNodeId,
      paidNode
    );
    assert.equal(state.launches.length, 1);
    assert.equal(
      (await mesh.getInference('mesh-llm-paid', '')).targetNodeId,
      otherPaidNode
    );
    assert.equal(state.launches.length, 1);
    // When a configured target belongs to another membership, switch only the
    // owned client to its one invitation. Never race unrelated paid invites.
    state.catalog.data[1].payment.offers =
      state.catalog.data[1].payment.offers.filter(
        offer => offer.provider_id !== paidNode
      );
    await mesh.configure('mesh-llm-paid', choice);
    assert.equal(state.launches.length, 2);
    assert.equal(
      state.launches.at(-1).args.filter(arg => arg === '--join-file').length,
      1
    );
    assert.equal(
      state.writes
        .filter(write => write.path.endsWith('paid-invite.token'))
        .at(-1).contents,
      token
    );
    assert.ok(state.launches.every(launch => !launch.args.includes('--auto')));
    mesh.stop();
  });

  await test('an unavailable explicit paid target does not fall back and remains visible for retry', async () => {
    reset();
    state.paidConfig.expectedNodeId = paidNode;
    const mesh = new SigDemoMesh();
    const choice = getSigDemoMeshOptionId(PAID_MODEL, otherPaidNode);
    await mesh.configure('mesh-llm-paid', choice);
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => {
      now += 10_000;
      return now;
    };
    try {
      await assert.rejects(
        mesh.getInference('mesh-llm-paid'),
        /paid mesh model is unavailable/
      );
      const listed = await mesh.getInferenceOptions('mesh-llm-paid');
      assert.equal(listed.selectionId, choice);
      assert.equal(
        listed.options.find(option => option.id === choice).available,
        false
      );
      assert.equal(listed.activeId, undefined);
    } finally {
      Date.now = originalNow;
      mesh.stop();
    }
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
