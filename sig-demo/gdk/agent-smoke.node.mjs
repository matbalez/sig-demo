// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Opt-in real native Goose agent / UniFFI / Koffi integration smoke. All model
// responses come from this synthetic loopback server. No app, mesh, wallet,
// Brave service or OpenAI service is accessed.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { loadSigAgent } from './agent-bindings.node.ts';

const libraryPath = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(
      new URL(
        './native-agent/target/release/libsig_demo_agent.dylib',
        import.meta.url
      )
    );
assert.ok(existsSync(libraryPath), 'Build the native agent first.');

const ambientKey = 'sk-synthetic-ambient-never-send';
const braveKey = 'synthetic-brave-never-send';
const providerPrivateMarker = 'synthetic-private-provider-detail';
const providerPrivateUrl = 'https://synthetic-private.test/never-expose';
const providerRequestId = 'synthetic-private-provider-request-id';
const providerErrorFixtures = new Map([
  [
    'known-server-error-mock',
    {
      status: 503,
      message: `all 2 target(s) for model '${providerPrivateMarker}' failed`,
      code: 'server-error',
      httpStatus: 503,
      reasonCode: 'mesh-routes-exhausted',
    },
  ],
  [
    'unknown-server-error-mock',
    {
      status: 503,
      message: `${providerPrivateMarker} ${providerPrivateUrl} ${ambientKey} ${braveKey}`,
      code: 'server-error',
      httpStatus: 503,
      reasonCode: null,
    },
  ],
  [
    'unknown-payment-error-mock',
    {
      status: 402,
      message: `payment was not authorized: ${providerPrivateMarker} ${providerPrivateUrl}`,
      code: 'payment-required',
      // GDK's typed CreditsExhausted error does not retain the HTTP status.
      httpStatus: null,
      reasonCode: null,
    },
  ],
]);
const providerErrorBodies = new Map();
process.env.OPENAI_API_KEY = ambientKey;
process.env.BRAVE_SEARCH_API_KEY = braveKey;
const target = 'a'.repeat(64);
const requests = [];
const requestBodies = [];
const validations = [];
const sockets = new Set();
let phase = 'setup';
let cancelledSocket = false;
let queuedActive = 0;
let queuedMaximum = 0;
const frames = values =>
  values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') +
  'data: [DONE]\n\n';
const chunk = (model, delta, finishReason = null, usage) => ({
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage && { usage }),
});
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const server = createServer(async (request, response) => {
  try {
    let input = '';
    for await (const data of request) input += data;
    const body = JSON.parse(input);
    requests.push(body.model);
    requestBodies.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-mesh-target'], target);
    assert.ok(!input.includes(ambientKey));
    assert.ok(!input.includes(braveKey));
    for (const localId of [
      'account-a',
      'account-b',
      'account-c',
      'chat-a',
      'chat-b',
      'chat-c',
      'synthetic-query',
      'synthetic-response',
      'session-query-',
      'session-response-',
      'context-0',
    ]) {
      assert.ok(
        !input.includes(localId),
        'A local session ID reached inference.'
      );
    }
    assert.equal(body.stream, true);
    assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    if (body.model === 'context-mock') {
      const context = JSON.parse(
        body.messages.find(message => message.role === 'user').content
      );
      assert.equal(context.currentRequest.text, 'Which one is largest?');
      assert.equal(context.currentRequest.author, 'Alice Example');
      assert.equal(context.currentDate, '2026-10-14');
      assert.ok(context.recentHistory.length <= 12);
      assert.ok(context.recentHistory.length > 0);
      assert.ok(
        context.recentHistory.reduce(
          (total, message) =>
            total +
            Buffer.byteLength(message.author) +
            Buffer.byteLength(message.text),
          0
        ) <= 6000
      );
      assert.ok(
        context.recentHistory.every(
          message =>
            Buffer.byteLength(message.author) +
              Buffer.byteLength(message.text) <=
            1500
        )
      );
      assert.ok(context.recentHistory.at(-1).text.includes('LATEST'));
      assert.ok(
        body.messages[0].content.includes('Answer only currentRequest.text')
      );
      assert.ok(body.messages[0].content.includes('quoted chat data'));
    }
    const providerError = providerErrorFixtures.get(body.model);
    if (providerError) {
      const errorBody = JSON.stringify({
        error: {
          message: providerError.message,
          type:
            providerError.status === 402 ? 'payment_required' : 'server_error',
          privateDetails: `${ambientKey} ${braveKey} ${providerPrivateUrl}`,
        },
      });
      providerErrorBodies.set(body.model, errorBody);
      response.writeHead(providerError.status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorBody),
        'x-request-id': providerRequestId,
        Connection: 'close',
      });
      response.end(errorBody);
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'close',
    });
    if (body.model === 'pending-mock') {
      response.flushHeaders();
      response.once('close', () => {
        cancelledSocket = true;
      });
      return;
    }
    if (body.model === 'invalid-tool-mock') {
      assert.equal(body.tools[0].function.name, 'brave_web_search');
      response.end(
        frames([
          chunk(body.model, {
            tool_calls: [
              {
                index: 0,
                id: 'synthetic-call',
                type: 'function',
                function: { name: 'brave_web_search', arguments: '{"query":' },
              },
            ],
          }),
          { model: body.model, choices: [], usage },
          chunk(body.model, {
            tool_calls: [{ index: 0, function: { arguments: '""}' } }],
          }),
          chunk(body.model, {}, 'tool_calls', usage),
        ])
      );
      return;
    }
    if (body.model === 'invalid-stream-mock') {
      response.end(
        frames([
          {
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        name: 'brave_web_search',
                        arguments: { query: 'never executed' },
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ])
      );
      return;
    }
    if (body.model === 'queued-session-mock') {
      queuedActive += 1;
      queuedMaximum = Math.max(queuedMaximum, queuedActive);
    }
    await delay(100);
    if (body.model === 'queued-session-mock') queuedActive -= 1;
    response.end(
      frames([
        chunk(body.model, { content: 'Hydrogen' }),
        { model: body.model, choices: [], usage },
        chunk(body.model, { content: ' is first.' }),
        chunk(body.model, {}, 'stop', usage),
      ])
    );
  } catch (error) {
    validations.push({
      phase,
      message:
        error instanceof Error ? error.message : 'Fixture validation failed.',
    });
    response.destroy();
  }
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
await new Promise((accept, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', accept);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const agent = loadSigAgent(libraryPath);
const config = (model, search = false) => ({
  provider: 'MeshLlm',
  model,
  baseUrl,
  targetNodeId: target,
  apiKey: ambientKey,
  ...(search && { braveApiKey: braveKey }),
});
const request = overrides => ({
  mode: 'Answer',
  queryId: 'synthetic-query',
  responseId: 'synthetic-response',
  sourceText: '@sig What comes first?',
  prompt: 'What comes first?',
  author: 'Alice',
  history: [],
  currentDate: '2026-10-14',
  ...overrides,
});
const idle = (objects = 0) =>
  assert.deepEqual(agent.diagnostics(), {
    activeFutures: 0,
    activeObjects: objects,
    pendingPolls: 0,
  });
async function collect(stream) {
  const events = [];
  try {
    for (;;) {
      // Each read consumes the next native event in one ordered stream.
      // oxlint-disable-next-line no-await-in-loop
      const event = await stream.nextEvent();
      if (!event) break;
      events.push(event);
    }
    return events;
  } finally {
    await stream.shutdown();
    stream.dispose();
  }
}
const findings = {};
try {
  phase = 'plain';
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 5);
  let events;
  try {
    events = await collect(await agent.start(config('plain-mock'), request()));
  } finally {
    clearInterval(ticker);
  }
  assert.equal(
    events
      .filter(event => event.kind === 'Text')
      .map(event => event.text)
      .join(''),
    'Hydrogen is first.'
  );
  assert.ok(events.some(event => event.kind === 'Done'));
  assert.ok(!events.some(event => event.kind === 'Error'));
  assert.equal(requests.filter(model => model === 'plain-mock').length, 1);
  assert.ok(ticks > 3, 'Native inference blocked the JavaScript event loop.');
  findings.oneInferenceAndNonblockingStreaming = true;
  idle();

  for (const [model, expected] of providerErrorFixtures) {
    phase = model;
    // Exercise the generated UniFFI event fields, not only Rust classifiers.
    // oxlint-disable-next-line no-await-in-loop
    events = await collect(await agent.start(config(model), request()));
    const errors = events.filter(event => event.kind === 'Error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, expected.code);
    assert.equal(errors[0].httpStatus, expected.httpStatus);
    assert.equal(errors[0].reasonCode, expected.reasonCode);
    assert.ok(!events.some(event => event.kind === 'Done'));
    assert.ok(!events.some(event => event.kind === 'Text'));
    const exposed = JSON.stringify(events, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    for (const privateValue of [
      ambientKey,
      braveKey,
      providerPrivateMarker,
      providerPrivateUrl,
      providerRequestId,
      baseUrl,
      `${baseUrl}/chat/completions`,
      providerErrorBodies.get(model),
    ]) {
      assert.equal(typeof privateValue, 'string');
      assert.ok(
        !exposed.includes(privateValue),
        'Native provider diagnostics exposed private fixture data.'
      );
    }
    idle();
  }
  findings.providerStatusAndAllowlistedReasonsSurviveNativeBindings = true;
  findings.providerBodiesUrlsAndSecretsNeverReachNativeEvents = true;

  phase = 'after-provider-errors';
  events = await collect(
    await agent.start(config('after-provider-errors-mock'), request())
  );
  assert.equal(
    events
      .filter(event => event.kind === 'Text')
      .map(event => event.text)
      .join(''),
    'Hydrogen is first.'
  );
  assert.ok(events.some(event => event.kind === 'Done'));
  assert.ok(!events.some(event => event.kind === 'Error'));
  findings.successfulStreamingStillWorksAfterProviderErrors = true;
  idle();

  phase = 'native-context';
  events = await collect(
    await agent.start(
      config('context-mock'),
      request({
        prompt: 'Which one is largest?',
        author: '  Alice   Example  ',
        history: Array.from({ length: 20 }, (_, index) => ({
          id: `context-${index}`,
          role: index % 2 ? 'Assistant' : 'User',
          author: 'Participant',
          text: `${index} ${'🙂'.repeat(600)} ${index === 19 ? 'LATEST' : ''}`,
        })),
      })
    )
  );
  assert.ok(events.some(event => event.kind === 'Done'));
  assert.equal(requests.filter(model => model === 'context-mock').length, 1);
  findings.rustBuildsBoundedContextAndSystemPrompt = true;
  idle();

  phase = 'invalid-tool-with-usage';
  events = await collect(
    await agent.start(config('invalid-tool-mock', true), request())
  );
  assert.ok(events.some(event => event.kind === 'Error'));
  assert.ok(!events.some(event => event.kind === 'Done'));
  assert.ok(
    !events.some(
      event => event.kind === 'Status' && event.status === 'Searching'
    )
  );
  assert.equal(
    requests.filter(model => model === 'invalid-tool-mock').length,
    1
  );
  findings.invalidToolAfterBillingUpdateDoesNotExecuteSearchOrRetry = true;
  idle();

  phase = 'invalid-stream';
  events = await collect(
    await agent.start(config('invalid-stream-mock', true), request())
  );
  assert.ok(events.some(event => event.kind === 'Error'));
  assert.ok(
    events.every(
      event =>
        !String(event.message ?? '').includes(ambientKey) &&
        !String(event.message ?? '').includes(braveKey)
    )
  );
  assert.equal(
    requests.filter(model => model === 'invalid-stream-mock').length,
    1
  );
  findings.nativeErrorEventIsSanitized = true;
  idle();

  phase = 'invalid-input';
  const previous = requests.length;
  events = await collect(
    await agent.start(
      config('never-called-mock'),
      request({ currentDate: '2026-02-30' })
    )
  );
  assert.ok(events.some(event => event.kind === 'Error'));
  assert.equal(requests.length, previous);
  findings.nativeValidationPrecedesInference = true;
  idle();

  phase = 'reusable-sessions';
  const sessions = [
    agent.createSession('account-a', 'chat-a'),
    agent.createSession('account-a', 'chat-b'),
    agent.createSession('account-b', 'chat-a'),
  ];
  try {
    const firstPrompt = 'Session Alpha marker';
    const firstSource = `@sig ${firstPrompt}`;
    events = await collect(
      await sessions[0].run(
        config('session-mock'),
        request({
          queryId: 'session-query-1',
          responseId: 'session-response-1',
          prompt: firstPrompt,
          sourceText: firstSource,
        })
      )
    );
    assert.ok(events.some(event => event.kind === 'Done'));
    idle(3);
    events = await collect(
      await sessions[0].run(
        config('session-mock'),
        request({
          queryId: 'session-query-2',
          responseId: 'session-response-2',
          prompt: 'Explain your last answer.',
          sourceText: '@sig Explain your last answer.',
          history: [
            {
              id: 'session-query-1',
              role: 'User',
              author: 'Alice',
              text: firstSource,
            },
            {
              id: 'session-response-1',
              role: 'Assistant',
              author: 'Sig',
              text: 'Hydrogen is first.',
            },
          ],
        })
      )
    );
    assert.ok(events.some(event => event.kind === 'Done'));
    const retained = requestBodies.filter(
      body => body.model === 'session-mock'
    );
    assert.equal(retained.length, 2);
    assert.ok(
      retained[1].messages.some(
        message =>
          message.role === 'assistant' &&
          message.content.includes('Hydrogen is first.')
      ),
      'A repeated run lost the existing native assistant turn.'
    );
    assert.ok(JSON.stringify(retained[1].messages).includes(firstPrompt));
    idle(3);

    // Independent account/chat handles must retain only their own conversation.
    await Promise.all(
      sessions.slice(1).map(async session => {
        const isolatedEvents = await collect(
          await session.run(config('isolated-session-mock'), request())
        );
        assert.ok(isolatedEvents.some(event => event.kind === 'Done'));
      })
    );
    for (const body of requestBodies.filter(
      value => value.model === 'isolated-session-mock'
    )) {
      assert.ok(!JSON.stringify(body.messages).includes(firstPrompt));
      assert.ok(!body.messages.some(message => message.role === 'assistant'));
    }
    const queued = await Promise.all(
      [1, 2].map(async index =>
        collect(
          await sessions[0].run(
            config('queued-session-mock'),
            request({
              queryId: `queued-query-${index}`,
              responseId: `queued-response-${index}`,
            })
          )
        )
      )
    );
    assert.ok(
      queued.every(values => values.some(event => event.kind === 'Done'))
    );
    assert.equal(
      requests.filter(model => model === 'queued-session-mock').length,
      2
    );
    assert.equal(
      queuedMaximum,
      1,
      'One chat issued overlapping inference turns.'
    );
    findings.nativeSessionSerializesConcurrentRuns = true;
    findings.nativeSessionReusesConversationAndIsolatesAccountsAndChats = true;
  } finally {
    for (const session of sessions) session.dispose();
  }
  idle();

  phase = 'cancel';
  const cancelledSession = agent.createSession('account-c', 'chat-c');
  const stream = await cancelledSession.run(config('pending-mock'), request());
  try {
    const deadline = performance.now() + 3000;
    while (!requests.includes('pending-mock') && performance.now() < deadline) {
      // Wait only for the local request to reach the fixture before cancelling.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    assert.ok(requests.includes('pending-mock'));
    stream.cancel();
    await stream.shutdown();
    const closedDeadline = performance.now() + 3000;
    while (!cancelledSocket && performance.now() < closedDeadline) {
      // The native cancellation must close its pending HTTP stream.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    assert.ok(cancelledSocket);
  } finally {
    await stream.shutdown();
    stream.dispose();
  }
  idle(1);
  try {
    events = await collect(
      await cancelledSession.run(
        config('after-cancel-mock'),
        request({
          queryId: 'after-cancel-query',
          responseId: 'after-cancel-response',
        })
      )
    );
    assert.ok(events.some(event => event.kind === 'Done'));
  } finally {
    cancelledSession.dispose();
  }
  findings.cancellationDrainsNativeJobAndClosesSocket = true;
  findings.cancelledSessionCanRunAgainWithoutLeakingAnActiveJob = true;
  idle();
  assert.deepEqual(validations, []);
  process.stdout.write(
    `${JSON.stringify({ ok: true, findings, requests: requests.length, diagnostics: agent.diagnostics() })}\n`
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, phase, error: error instanceof Error ? error.message : 'Native agent smoke failed.', validations, diagnostics: agent.diagnostics() })}\n`
  );
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(accept => server.close(accept));
}
