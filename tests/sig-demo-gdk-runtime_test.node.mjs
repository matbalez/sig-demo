// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createSigDemoAgentRuntime } from '../app/SigDemoAgentRuntime.node.ts';
import {
  safeSigDemoAgentError,
  sigDemoAgentErrorCode,
  sigDemoAgentFailureDetails,
  SigDemoAgentRuntimeError,
} from '../app/SigDemoAgentErrors.std.ts';

const { AbortController, DOMException } = globalThis;
const route = {
  baseUrl: 'http://127.0.0.1:9337/v1',
  model: 'mesh-test-model',
  targetNodeId: 'a'.repeat(64),
};
const sessionEnvelope = {
  accountId: 'local-account-a',
  chatId: 'chat-a',
  queryMessageId: 'question-a',
  responseMessageId: 'answer-a',
  sourceText: '@sig What is first?',
};
const meshRequest = {
  ...sessionEnvelope,
  provider: 'mesh-llm',
  prompt: 'What is first?',
  ...route,
};
const text = value => ({ kind: 'Text', text: value });
const done = { kind: 'Done' };

function mockAgent(events = [], options = {}) {
  const starts = [];
  const received = [];
  const lifecycle = { cancelled: 0, shutdown: 0, disposed: 0 };
  const sessionCreates = [];
  let sessionDisposals = 0;
  const makeStream = () => {
    let index = 0;
    return {
      async nextEvent(signal) {
        signal?.throwIfAborted();
        const event = events[index];
        index += 1;
        return typeof event === 'function' ? event(signal) : (event ?? null);
      },
      cancel() {
        lifecycle.cancelled += 1;
      },
      async shutdown() {
        lifecycle.shutdown += 1;
        await options.shutdown?.();
      },
      dispose() {
        lifecycle.disposed += 1;
      },
    };
  };
  const start = async (config, request, signal) => {
    signal.throwIfAborted();
    starts.push({ config, request });
    if (options.startError) throw options.startError;
    return makeStream();
  };
  const runtime = createSigDemoAgentRuntime({
    start,
    createSession(accountId, chatId) {
      sessionCreates.push({ accountId, chatId });
      return {
        run: start,
        dispose() {
          sessionDisposals += 1;
        },
      };
    },
  });
  return {
    ...runtime,
    starts,
    received,
    lifecycle,
    sessionCreates,
    sessionDisposals: () => sessionDisposals,
    run: (
      request = meshRequest,
      credentials = {},
      signal = new AbortController().signal
    ) =>
      runtime.runSigDemoAgent(request, credentials, signal, event =>
        received.push(event)
      ),
  };
}
const visible = events =>
  events
    .filter(event => event.type === 'text')
    .map(event => event.text)
    .join('');

await test('forwards raw chat candidates to one native agent and streams its events immediately', async () => {
  let unblock;
  const held = new Promise(resolve => {
    unblock = resolve;
  });
  const runtime = mockAgent([
    text('Hydrogen'),
    async () => {
      await held;
      return text(' is first.');
    },
    done,
  ]);
  const history = Array.from({ length: 20 }, (_, i) => ({
    id: `history-${i}`,
    role: i % 2 ? 'assistant' : 'user',
    author: '🪿'.repeat(100),
    text: `Opening ${'x'.repeat(2000)} ending ${i}`,
  }));
  const result = runtime.run(
    {
      ...meshRequest,
      history,
      author: ' Alice\nSmith ',
      currentDate: '2026-10-14',
    },
    {
      get apiKey() {
        throw new Error('Mesh accessed an OpenAI credential.');
      },
      braveApiKey: 'synthetic-brave-key',
    }
  );
  await tick();
  assert.equal(visible(runtime.received), 'Hydrogen');
  assert.equal(
    runtime.received.some(event => event.type === 'done'),
    false
  );
  assert.equal(runtime.starts.length, 1);
  const { config, request } = runtime.starts[0];
  assert.deepEqual(config, {
    provider: 'MeshLlm',
    model: route.model,
    baseUrl: route.baseUrl,
    targetNodeId: route.targetNodeId,
    apiKey: undefined,
    braveApiKey: 'synthetic-brave-key',
  });
  assert.equal(request.author, ' Alice\nSmith ');
  assert.equal(request.history.length, 20);
  assert.deepEqual(request.history[0], { ...history[0], role: 'User' });
  assert.deepEqual(request.history[1], { ...history[1], role: 'Assistant' });
  assert.equal(request.mode, 'Answer');
  assert.equal(request.prompt, meshRequest.prompt);
  assert.equal(request.currentDate, '2026-10-14');
  assert.equal(config.systemPrompt, undefined);
  unblock();
  await result;
  assert.equal(visible(runtime.received), 'Hydrogen is first.');
  assert.deepEqual(runtime.lifecycle, {
    cancelled: 0,
    shutdown: 1,
    disposed: 1,
  });
});

await test('ChatGPT passes its credential only and never reads the Brave key', async () => {
  const runtime = mockAgent([text('Answer'), done]);
  await runtime.run(
    { ...sessionEnvelope, provider: 'chatgpt', prompt: 'Hi' },
    {
      apiKey: 'synthetic-openai-key',
      get braveApiKey() {
        throw new Error('ChatGPT accessed a Brave credential.');
      },
    }
  );
  assert.equal(runtime.starts[0].config.provider, 'Chatgpt');
  assert.equal(runtime.starts[0].config.apiKey, 'synthetic-openai-key');
  assert.equal(runtime.starts[0].config.braveApiKey, undefined);
});

await test('search and model-turn events are forwarded without a TypeScript tool loop', async () => {
  const runtime = mockAgent([
    { kind: 'Timing', phase: 'model-turn', durationMs: 0n },
    { kind: 'Status', status: 'Searching' },
    { kind: 'Timing', phase: 'search', durationMs: 12n },
    { kind: 'Status', status: 'Responding' },
    { kind: 'Timing', phase: 'model-turn', durationMs: 0n },
    text('Source-backed answer'),
    done,
  ]);
  await runtime.run();
  assert.equal(runtime.starts.length, 1);
  assert.deepEqual(
    runtime.received.filter(event => event.type === 'status'),
    [
      { type: 'status', status: 'searching' },
      { type: 'status', status: 'responding' },
    ]
  );
  assert.equal(
    runtime.received.filter(
      event => event.type === 'timing' && event.phase === 'model-turn'
    ).length,
    2
  );
  assert.equal(
    runtime.received.find(
      event => event.type === 'timing' && event.phase === 'search'
    ).durationMs,
    12
  );
});

await test('free warmup is a native mode with no TypeScript prompt or chat input', async () => {
  const runtime = mockAgent([
    { kind: 'Timing', phase: 'warmup', durationMs: 15n },
    done,
  ]);
  const timings = [];
  await runtime.warmSigDemoMesh(route, new AbortController().signal, event =>
    timings.push(event)
  );
  assert.deepEqual(runtime.starts[0].request, {
    mode: 'Warmup',
    queryId: '',
    responseId: '',
    sourceText: '',
    prompt: '',
    author: undefined,
    history: [],
    currentDate: undefined,
  });
  assert.equal(runtime.starts[0].config.systemPrompt, undefined);
  assert.deepEqual(timings, [
    { type: 'timing', phase: 'warmup', durationMs: 15 },
  ]);
});

await test('completion waits for native worker shutdown before publishing done', async () => {
  let drain;
  const gate = new Promise(resolve => {
    drain = resolve;
  });
  const runtime = mockAgent([text('Answer'), done], { shutdown: () => gate });
  const pending = runtime.run();
  await tick();
  assert.equal(
    runtime.received.some(event => event.type === 'done'),
    false
  );
  assert.equal(runtime.lifecycle.disposed, 0);
  drain();
  await pending;
  assert.equal(runtime.received.at(-1).type, 'done');
  assert.equal(runtime.lifecycle.disposed, 1);
});

await test('native classified errors retain their fixed code and always drain/dispose', async () => {
  const runtime = mockAgent([
    {
      kind: 'Error',
      code: 'stream-format-invalid',
      message:
        'The inference provider returned an unreadable response. Please try again.',
    },
  ]);
  await assert.rejects(
    runtime.run(),
    error =>
      error instanceof SigDemoAgentRuntimeError &&
      error.code === 'stream-format-invalid' &&
      error.message.includes('unreadable response')
  );
  assert.deepEqual(runtime.lifecycle, {
    cancelled: 0,
    shutdown: 1,
    disposed: 1,
  });
  assert.equal(runtime.starts.length, 1);
});

await test('native startup errors expose classifications without raw SDK diagnostics', async () => {
  const runtime = mockAgent([], {
    startError: { kind: 'Generic', details: 'private-key-and-private-chat' },
  });
  await assert.rejects(
    runtime.run(),
    error => error.message === 'Sig could not complete the request. Try again.'
  );
  assert.equal(runtime.lifecycle.disposed, 0);
});

await test('native HTTP503 and402 diagnostics survive runtime wrapping without inventing status or accepting raw reasons', async () => {
  for (const fixture of [
    {
      code: 'server-error',
      httpStatus: 503,
      reasonCode: 'mesh-routes-exhausted',
    },
    {
      code: 'payment-required',
      httpStatus: 402,
      reasonCode: 'payment-route-denied',
    },
    { code: 'server-error', httpStatus: undefined, reasonCode: undefined },
    { code: 'payment-required', httpStatus: undefined, reasonCode: undefined },
  ]) {
    const runtime = mockAgent([
      { kind: 'Error', message: 'Fixed native error.', ...fixture },
    ]);
    // Independent native errors must be observed through the complete adapter.
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(runtime.run(), error => {
      assert.ok(error instanceof SigDemoAgentRuntimeError);
      assert.equal(error.code, fixture.code);
      assert.equal(error.httpStatus, fixture.httpStatus);
      assert.equal(error.reasonCode, fixture.reasonCode);
      return true;
    });
    assert.equal(runtime.lifecycle.shutdown, 1);
    assert.equal(runtime.lifecycle.disposed, 1);
    assert.equal(runtime.starts.length, 1);
  }
  const error = new SigDemoAgentRuntimeError('Fixed message.', 'server-error', {
    httpStatus: 999,
    reasonCode: 'private-api-key-and-chat',
  });
  assert.equal(error.httpStatus, undefined);
  assert.equal(error.reasonCode, undefined);
});

await test('diagnostic labels reject URLs, credentials, arbitrary phases and full node identities', () => {
  const error = new SigDemoAgentRuntimeError('Fixed message.', 'server-error');
  for (const model of [
    'https://private.example/data',
    'sk-proj-private-key',
    'model\nprivate-chat',
    'x'.repeat(97),
  ]) {
    const details = sigDemoAgentFailureDetails(error, {
      provider: 'mesh-llm-paid',
      phase: 'private phase',
      model,
      nodeId: `${route.targetNodeId}\nprivate-chat`,
    });
    assert.equal(details.model, undefined);
    assert.equal(details.nodeId, undefined);
    assert.equal(details.phase, 'runtime-starting');
  }
  assert.equal(
    sigDemoAgentFailureDetails(error, {
      provider: 'mesh-llm',
      phase: 'model-turn',
      nodeId: route.targetNodeId,
    }).nodeId,
    route.targetNodeId.slice(0, 10)
  );
});

await test('cancellation cancels the native worker and drains it without more text or completion', async () => {
  const runtime = mockAgent([
    text('Visible'),
    signal =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              new DOMException('private cancellation details', 'AbortError')
            ),
          { once: true }
        );
      }),
  ]);
  const controller = new AbortController();
  const run = runtime.run(meshRequest, {}, controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(run, /request was cancelled/);
  assert.equal(visible(runtime.received), 'Visible');
  assert.deepEqual(runtime.lifecycle, {
    cancelled: 1,
    shutdown: 1,
    disposed: 1,
  });
  assert.equal(
    runtime.received.some(event => event.type === 'done'),
    false
  );
});

await test('request deadline cancels the native worker and releases resources', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = mockAgent([
    signal =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('private timeout', 'AbortError')),
          { once: true }
        );
      }),
  ]);
  const pending = runtime.run();
  await tick();
  context.mock.timers.tick(120000);
  await assert.rejects(pending, /request timed out/);
  assert.deepEqual(runtime.lifecycle, {
    cancelled: 1,
    shutdown: 1,
    disposed: 1,
  });
});

await test('an unfinished native channel is reported and cleaned up without retry', async () => {
  const runtime = mockAgent([text('Partial')]);
  await assert.rejects(runtime.run(), /stopped before completing/);
  assert.equal(runtime.starts.length, 1);
  assert.deepEqual(runtime.lifecycle, {
    cancelled: 0,
    shutdown: 1,
    disposed: 1,
  });
});

await test('invalid IPC shapes and oversized envelopes are rejected before native calls', async () => {
  const runtime = mockAgent([done]);
  for (const request of [
    { ...meshRequest, unknown: true },
    { ...meshRequest, author: 'x'.repeat(4097) },
    {
      ...meshRequest,
      history: Array.from({ length: 61 }, () => ({
        id: 'history-id',
        role: 'user',
        author: 'Alice',
        text: 'Hi',
      })),
    },
    {
      ...meshRequest,
      history: [
        {
          id: 'history-id',
          role: 'user',
          author: 'Alice',
          text: 'x'.repeat(4 * 1024 * 1024),
        },
      ],
    },
  ]) {
    // Each malformed request must fail before a native job starts.
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(runtime.run(request), /Invalid agent request/);
  }
  assert.equal(runtime.starts.length, 0);
});

await test('SDK diagnostic classification remains fixed for thrown and streamed shapes', () => {
  const secret = 'private-key-and-private-chat';
  const fixtures = [
    [
      '-32602: The model produced malformed tool arguments.',
      'tool-arguments-invalid',
    ],
    ["-32602: The model's response was truncated", 'tool-arguments-incomplete'],
    [
      'Network error: Stream decode error: Failed to parse streaming chunk:',
      'stream-format-invalid',
    ],
    [
      'Network error: Stream decode error: error decoding response body',
      'stream-interrupted',
    ],
  ];
  for (const [prefix, code] of fixtures)
    for (const field of ['details', 'message']) {
      const error = { kind: 'Generic', [field]: `${prefix} ${secret}` };
      assert.equal(sigDemoAgentErrorCode(error), code);
      assert.ok(!safeSigDemoAgentError(error).includes(secret));
    }
  assert.equal(
    new SigDemoAgentRuntimeError('Safe message', secret).code,
    'application-error'
  );
});

await test('reuses one native session per local account and chat across provider changes', async () => {
  const runtime = mockAgent([text('Answer'), done]);
  await runtime.run();
  await runtime.run({
    ...meshRequest,
    queryMessageId: 'question-b',
    responseMessageId: 'answer-b',
  });
  await runtime.run(
    { ...sessionEnvelope, provider: 'chatgpt', prompt: 'Hello' },
    { apiKey: 'synthetic-openai-key' }
  );
  assert.deepEqual(runtime.sessionCreates, [
    { accountId: 'local-account-a', chatId: 'chat-a' },
  ]);
  assert.equal(runtime.starts.length, 3);
  assert.equal(runtime.lifecycle.shutdown, 3);
  assert.equal(runtime.sessionDisposals(), 0);
  assert.equal(
    runtime.starts[0].request.queryId,
    sessionEnvelope.queryMessageId
  );
  assert.equal(
    runtime.starts[0].request.responseId,
    sessionEnvelope.responseMessageId
  );
  assert.equal(
    runtime.starts[0].request.sourceText,
    sessionEnvelope.sourceText
  );
  assert.equal(runtime.starts[0].request.accountId, undefined);
  assert.equal(runtime.starts[0].request.chatId, undefined);
  runtime.disposeSessions();
  assert.equal(runtime.sessionDisposals(), 1);
});

await test('keeps other chats and accounts separate and releases all handles on reset', async () => {
  const runtime = mockAgent([done]);
  await runtime.run();
  await runtime.run({ ...meshRequest, chatId: 'chat-b' });
  await runtime.run({ ...meshRequest, accountId: 'local-account-b' });
  assert.deepEqual(runtime.sessionCreates, [
    { accountId: 'local-account-a', chatId: 'chat-a' },
    { accountId: 'local-account-a', chatId: 'chat-b' },
    { accountId: 'local-account-b', chatId: 'chat-a' },
  ]);
  runtime.disposeSessions();
  assert.equal(runtime.sessionDisposals(), 3);
  await runtime.run();
  assert.equal(runtime.sessionCreates.length, 4);
  runtime.disposeSessions();
  assert.equal(runtime.sessionDisposals(), 4);
});

await test('answers require stable session and source message identities before native calls', async () => {
  const runtime = mockAgent([done]);
  for (const key of [
    'accountId',
    'chatId',
    'queryMessageId',
    'responseMessageId',
    'sourceText',
  ]) {
    const request = { ...meshRequest };
    delete request[key];
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(runtime.run(request), /Invalid agent session request/);
  }
  assert.equal(runtime.starts.length, 0);
  assert.equal(runtime.sessionCreates.length, 0);
});
