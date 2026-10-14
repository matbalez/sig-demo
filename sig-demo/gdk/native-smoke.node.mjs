// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Opt-in actual SDK/UniFFI/Koffi smoke; build-native.sh is a prerequisite.
// All inference uses fake credentials and a synthetic loopback HTTP server.
// It never launches mesh-llm, opens an app profile, or accesses a wallet.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { loadGdk } from './bindings.node.ts';

const { AbortController } = globalThis;

const libraryPath = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(
      new URL('./native/target/release/libgoose_sdk.dylib', import.meta.url)
    );
assert.ok(
  existsSync(libraryPath),
  'Build the native SDK first: sh sig-demo/gdk/build-native.sh'
);

const ambientKey = 'sk-synthetic-ambient-key-never-send';
const braveKey = 'synthetic-brave-key-never-send';
process.env.OPENAI_API_KEY = ambientKey;
process.env.BRAVE_SEARCH_API_KEY = braveKey;
process.env.SIG_DEMO_SYNTHETIC_OPENAI_KEY = 'sk-synthetic-explicit-openai-key';
const requests = [];
const sockets = new Set();
let startAborted = false;
let readAborted = false;
let phase = 'setup';
const validations = [];
const citation = {
  type: 'url_citation',
  url: 'https://example.test/source',
  title: 'Mock source',
  start_index: 0,
  end_index: 11,
};
const frames = values =>
  values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') +
  'data: [DONE]\n\n';
const completion = (model, content) =>
  frames([
    { model, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    {
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
const server = createServer(async (request, response) => {
  try {
    let input = '';
    for await (const chunk of request) input += chunk;
    const body = JSON.parse(input);
    requests.push({ path: request.url, model: body.model });
    assert.ok(!input.includes(ambientKey));
    assert.ok(!input.includes(braveKey));
    if (request.url === '/chat/completions') {
      assert.equal(
        request.headers.authorization,
        'Bearer sk-synthetic-explicit-openai-key'
      );
      assert.equal(body.stream, true);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      response.end(completion(body.model, 'Explicit OpenAI key mock.'));
      return;
    }
    if (request.url.endsWith('/responses')) {
      assert.equal(
        request.headers.authorization,
        'Bearer sk-synthetic-explicit-openai-key'
      );
      assert.equal(body.store, false);
      assert.equal(body.max_tool_calls, 2);
      assert.ok(body.tools.some(tool => tool.type === 'web_search'));
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      response.end(
        frames([
          {
            type: 'response.created',
            sequence_number: 1,
            response: {
              id: 'synthetic-response',
              object: 'response',
              created_at: 0,
              model: body.model,
              status: 'in_progress',
              output: [],
            },
          },
          {
            type: 'response.output_item.added',
            sequence_number: 2,
            output_index: 0,
            item: {
              type: 'web_search_call',
              id: 'synthetic-search',
              status: 'in_progress',
            },
          },
          {
            type: 'response.web_search_call.searching',
            sequence_number: 3,
            item_id: 'synthetic-search',
            output_index: 0,
          },
          {
            type: 'response.output_item.done',
            sequence_number: 4,
            output_index: 0,
            item: {
              type: 'web_search_call',
              id: 'synthetic-search',
              status: 'completed',
            },
          },
          {
            type: 'response.output_text.delta',
            sequence_number: 5,
            item_id: 'synthetic-message',
            output_index: 1,
            content_index: 0,
            delta: 'Mock answer',
          },
          {
            type: 'response.output_item.done',
            sequence_number: 6,
            output_index: 1,
            item: {
              type: 'message',
              id: 'synthetic-message',
              status: 'completed',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'Mock answer',
                  annotations: [citation],
                },
              ],
            },
          },
          {
            type: 'response.completed',
            sequence_number: 7,
            response: {
              id: 'synthetic-response',
              object: 'response',
              created_at: 0,
              model: body.model,
              status: 'completed',
              output: [
                {
                  type: 'web_search_call',
                  id: 'synthetic-search',
                  status: 'completed',
                },
                {
                  type: 'message',
                  id: 'synthetic-message',
                  status: 'completed',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text: 'Mock answer',
                      annotations: [citation],
                    },
                  ],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ])
      );
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-mesh-target'], 'a'.repeat(64));
    assert.equal(body.stream, true);
    if (body.model === 'pending-start-mock') {
      response.once('close', () => {
        startAborted = true;
      });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'close',
    });
    if (body.model === 'pending-read-mock') {
      response.flushHeaders();
      response.once('close', () => {
        readAborted = true;
      });
      return;
    }
    if (body.model === 'plain-mock') {
      await delay(250);
      response.end(completion(body.model, 'Hydrogen is first.'));
      return;
    }
    if (body.model === 'tool-mock') {
      assert.equal(body.tools[0].function.name, 'brave_web_search');
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
                      id: 'synthetic-tool',
                      type: 'function',
                      function: {
                        name: 'google_search',
                        arguments: '{"query":"synthetic ',
                      },
                      extra_content: {
                        google: { thought_signature: 'synthetic-signature' },
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: 'search"}' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        ])
      );
      return;
    }
    if (body.model === 'replay-mock') {
      const assistant = body.messages.find(
        message => message.role === 'assistant'
      );
      assert.equal(assistant.tool_calls[0].id, 'synthetic-tool');
      assert.equal(
        assistant.tool_calls[0].extra_content.google.thought_signature,
        'synthetic-signature'
      );
      const tool = body.messages.find(message => message.role === 'tool');
      assert.equal(tool.tool_call_id, 'synthetic-tool');
      assert.ok(tool.content.includes('https://example.test/source'));
    }
    response.end(completion(body.model, 'Mock final answer.'));
  } catch (error) {
    validations.push({
      path: request.url,
      message: String(error?.message)
        .replace(/sk-[A-Za-z0-9_-]+/g, '[synthetic-key]')
        .slice(0, 300),
    });
    response.writeHead(500);
    response.end(
      JSON.stringify({
        error: { message: 'The synthetic request failed validation.' },
      })
    );
  }
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const port = server.address().port;
const gdk = loadGdk(libraryPath);
const makeProvider = () =>
  gdk.declarativeProviderFromJson(
    JSON.stringify({
      name: 'synthetic-mesh',
      engine: 'openai',
      display_name: 'Synthetic mesh',
      base_url: `http://127.0.0.1:${port}/v1`,
      base_path: 'v1/chat/completions',
      api_key_env: '',
      requires_auth: false,
      models: [],
      timeout_seconds: 5,
      supports_streaming: true,
    })
  );
const model = name => ({
  modelName: name,
  contextLimit: 4096,
  maxTokens: 64,
  toolshim: false,
  timeoutMs: 5000,
  requestHeaders: { 'x-mesh-target': 'a'.repeat(64) },
});
const messages = [
  {
    role: 'User',
    content: [{ kind: 'Text', text: 'A synthetic local test.' }],
  },
];
const searchTool = {
  name: 'brave_web_search',
  description: 'A synthetic tool schema. No real search is called.',
  inputSchemaJson: JSON.stringify({
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  }),
};
async function consume(stream) {
  const chunks = [];
  try {
    for (;;) {
      // Native stream reads consume one ordered sequence and cannot overlap.
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await stream.nextChunk();
      if (!chunk) break;
      chunks.push(chunk);
      if (chunk.kind === 'EndChunk') break;
    }
    return chunks;
  } finally {
    stream.dispose();
  }
}
async function waitFor(predicate, timeout = 2000) {
  const end = performance.now() + timeout;
  while (!predicate() && performance.now() < end) {
    // Poll one synthetic socket closure until observed or the deadline.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
  assert.ok(predicate(), 'Synthetic cancellation did not close its socket.');
}

const findings = {};
try {
  phase = 'standalone-future-liveness';
  // A separate Node/Electron process has no HTTP server or app event loop to
  // keep it alive. Its one UniFFI future must retain and release that loop.
  const childProgram = `
    import assert from 'node:assert/strict';
    import process from 'node:process';
    import { loadGdk } from ${JSON.stringify(new URL('./bindings.node.ts', import.meta.url).href)};
    const gdk = loadGdk(${JSON.stringify(libraryPath)});
    const provider = gdk.declarativeProviderFromJson(${JSON.stringify(JSON.stringify({ name: 'synthetic-metadata', engine: 'openai', display_name: 'Synthetic metadata', base_url: 'http://127.0.0.1:9', base_path: 'v1/chat/completions', api_key_env: '', requires_auth: false, models: [], timeout_seconds: 5, supports_streaming: true }))});
    try {
      assert.equal(await provider.contextLimit({ modelName: 'synthetic', contextLimit: 1234 }), 1234n);
    } finally {
      provider.dispose();
    }
    assert.deepEqual(gdk.diagnostics(), { activeFutures: 0, activeObjects: 0, pendingPolls: 0 });
    process.stdout.write('native-future-liveness-ok\\n');
  `;
  const child = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', childProgram],
    {
      timeout: 5000,
      env: {
        ...process.env,
        ...(process.versions.electron && { ELECTRON_RUN_AS_NODE: '1' }),
      },
    }
  );
  assert.equal(child.stdout.trim(), 'native-future-liveness-ok');
  findings.standaloneFutureKeepsNodeAlive = true;
  const provider = makeProvider();
  try {
    assert.equal(provider.name(), 'synthetic-mesh');
    assert.ok(provider.supportedFeatures().includes('Streaming'));
    assert.equal(
      await provider.contextLimit({
        modelName: 'synthetic',
        contextLimit: 1234,
      }),
      1234n
    );
    for (let i = 0; i < 25; i += 1)
      assert.equal(provider.name(), 'synthetic-mesh');
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 5);
    ticker.unref();
    phase = 'plain-stream';
    const chunks = await consume(
      await provider.stream(
        model('plain-mock'),
        'Synthetic system.',
        messages,
        []
      )
    );
    clearInterval(ticker);
    assert.equal(
      chunks
        .filter(chunk => chunk.kind === 'TextChunk')
        .map(chunk => chunk.text)
        .join(''),
      'Hydrogen is first.'
    );
    assert.ok(ticks >= 15, 'Native HTTP blocked the JavaScript event loop.');
    findings.responsiveTimerTicks = ticks;
    phase = 'complete';
    const completed = await provider.complete(
      model('complete-mock'),
      'Synthetic system.',
      messages,
      []
    );
    assert.equal(
      completed.content.find(content => content.kind === 'Text').text,
      'Mock final answer.'
    );
    phase = 'tool-stream';
    const toolChunks = await consume(
      await provider.stream(model('tool-mock'), 'Synthetic system.', messages, [
        searchTool,
      ])
    );
    const tool = toolChunks.find(chunk => chunk.kind === 'ToolChunk');
    assert.equal(
      toolChunks.filter(chunk => chunk.kind === 'ToolChunk').length,
      1
    );
    assert.equal(tool.name, 'google_search');
    assert.deepEqual(JSON.parse(tool.argumentsJson), {
      query: 'synthetic search',
    });
    assert.equal(
      JSON.parse(tool.providerMetadataJson).extra_content.google
        .thought_signature,
      'synthetic-signature'
    );
    phase = 'tool-replay';
    await consume(
      await provider.stream(
        model('replay-mock'),
        'Synthetic system.',
        [
          ...messages,
          {
            role: 'Assistant',
            content: [
              {
                kind: 'ToolRequest',
                id: tool.id,
                name: 'brave_web_search',
                argumentsJson: tool.argumentsJson,
                providerMetadataJson: tool.providerMetadataJson,
              },
            ],
          },
          {
            role: 'Tool',
            content: [
              {
                kind: 'ToolResult',
                id: tool.id,
                success: true,
                contentJson: JSON.stringify({
                  url: 'https://example.test/source',
                }),
              },
            ],
          },
        ],
        [searchTool]
      )
    );
    phase = 'cancel-start';
    const startController = new AbortController();
    const starting = provider.stream(
      model('pending-start-mock'),
      'Synthetic system.',
      messages,
      [],
      startController.signal
    );
    await waitFor(() =>
      requests.some(request => request.model === 'pending-start-mock')
    );
    startController.abort();
    await assert.rejects(starting, error => error.name === 'AbortError');
    await waitFor(() => startAborted);
    phase = 'cancel-read';
    const reading = await provider.stream(
      model('pending-read-mock'),
      'Synthetic system.',
      messages,
      []
    );
    const readController = new AbortController();
    const pendingRead = reading.nextChunk(readController.signal);
    await assert.rejects(reading.nextChunk(), /Only one GDK stream read/);
    await delay(30);
    readController.abort();
    await assert.rejects(pendingRead, error => error.name === 'AbortError');
    reading.dispose();
    reading.dispose();
    await waitFor(() => readAborted);
    await assert.rejects(reading.nextChunk(), /disposed/);
  } finally {
    provider.dispose();
    provider.dispose();
  }
  const openai = gdk.openaiProvider(
    'sk-synthetic-explicit-openai-key',
    `http://127.0.0.1:${port}`
  );
  try {
    phase = 'openai-explicit-factory';
    const chunks = await consume(
      await openai.stream(
        {
          modelName: 'gpt-6-luna',
          contextLimit: 4096,
          maxTokens: 64,
          toolshim: false,
          timeoutMs: 5000,
        },
        'Synthetic system.',
        messages,
        []
      )
    );
    assert.equal(
      chunks
        .filter(chunk => chunk.kind === 'TextChunk')
        .map(chunk => chunk.text)
        .join(''),
      'Explicit OpenAI key mock.'
    );
  } finally {
    openai.dispose();
  }
  // The official SDK deliberately routes custom-host OpenAI factories to chat.
  // Force its genuine Responses formatter with a synthetic declarative provider.
  const responsesProvider = gdk.declarativeProviderFromJson(
    JSON.stringify({
      name: 'synthetic-openai-responses',
      engine: 'openai',
      display_name: 'Synthetic Responses',
      base_url: `http://127.0.0.1:${port}`,
      base_path: 'v1/responses',
      api_key_env: 'SIG_DEMO_SYNTHETIC_OPENAI_KEY',
      requires_auth: true,
      models: [],
      timeout_seconds: 5,
      supports_streaming: true,
    })
  );
  try {
    phase = 'openai-responses';
    const chunks = await consume(
      await responsesProvider.stream(
        {
          modelName: 'gpt-6-luna',
          contextLimit: 4096,
          maxTokens: 64,
          toolshim: false,
          timeoutMs: 5000,
          requestParamsJson: JSON.stringify({
            thinking_effort: 'off',
            store: false,
            web_search: true,
            max_tool_calls: 2,
          }),
        },
        'Synthetic system.',
        messages,
        []
      )
    );
    const text = chunks
      .filter(chunk => chunk.kind === 'TextChunk')
      .map(chunk => chunk.text)
      .join('');
    assert.ok(text.includes('Mock answer'));
    assert.ok(text.includes('https://example.test/source'));
    assert.ok(!chunks.some(chunk => chunk.kind === 'ErrorChunk'));
    findings.openaiBuiltInSearchAndCitation = true;
  } finally {
    responsesProvider.dispose();
  }
  assert.deepEqual(gdk.diagnostics(), {
    activeFutures: 0,
    activeObjects: 0,
    pendingPolls: 0,
  });
  process.stdout.write(
    JSON.stringify({
      passed: true,
      runtime: process.versions.electron ? 'electron' : 'node',
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      napi: process.versions.napi,
      syntheticRequests: requests.length,
      meshHasNoAmbientAuth: true,
      toolArgumentsAssembled: true,
      toolMetadataReplayed: true,
      cancelledStartClosedSocket: startAborted,
      cancelledReadClosedSocket: readAborted,
      diagnostics: gdk.diagnostics(),
      ...findings,
    }) + '\n'
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      passed: false,
      phase,
      requests,
      validations,
      runtime: process.versions.electron ? 'electron' : 'node',
      error: error?.name,
      message: String(error?.message)
        .replace(/sk-[A-Za-z0-9_-]+/g, '[synthetic-key]')
        .slice(0, 300),
      diagnostics: gdk.diagnostics(),
    }) + '\n'
  );
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolveClose => server.close(resolveClose));
}
