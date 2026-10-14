// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createSigDemoAgentRuntime } from '../app/SigDemoAgentRuntime.node.ts';
import {
  BraveSearch,
  parseSearchArguments,
  truncateUtf8,
} from '../app/SigDemoBrave.node.ts';
import { ToolTextFilter } from '../app/SigDemoToolCompat.node.ts';
import { safeSigDemoAgentError } from '../app/SigDemoAgentErrors.std.ts';

const { AbortController, DOMException, Response, structuredClone } = globalThis;

const route = {
  baseUrl: 'http://127.0.0.1:9337/v1',
  model: 'mesh-test-model',
  targetNodeId: 'a'.repeat(64),
};
const meshRequest = {
  provider: 'mesh-llm',
  prompt: 'What is the first element?',
  ...route,
};
const contextResponse = {
  grounding: {
    generic: [
      {
        title: 'Goose SDK',
        url: 'https://goose-docs.ai/docs/gdk/sdk/',
        snippets: ['The Rust SDK supports tools.'],
      },
    ],
  },
};
const text = value => ({ kind: 'TextChunk', text: value });
const end = { kind: 'EndChunk', usage: null };
const tool = (query, id = 'search-1', extra = {}) => ({
  kind: 'ToolChunk',
  id,
  name: 'brave_web_search',
  argumentsJson: JSON.stringify({ query }),
  index: 0,
  providerMetadataJson: null,
  ...extra,
});

function mockGdk(
  turns = [],
  completeResult = { content: [], messageJson: '{}', usage: null }
) {
  const calls = [];
  const creations = [];
  const disposed = { provider: 0, streams: 0 };
  const provider = {
    async stream(model, system, messages, tools, signal) {
      signal.throwIfAborted();
      calls.push({
        operation: 'stream',
        model: structuredClone(model),
        system,
        messages: structuredClone(messages),
        tools: structuredClone(tools),
      });
      const chunks = turns.shift();
      if (chunks instanceof Error || chunks?.kind) throw chunks;
      assert.ok(chunks, 'Unexpected additional inference turn');
      let index = 0;
      return {
        async nextChunk(nextSignal) {
          nextSignal.throwIfAborted();
          const value = chunks[index];
          index += 1;
          return typeof value === 'function'
            ? value(nextSignal)
            : (value ?? null);
        },
        dispose() {
          disposed.streams += 1;
        },
      };
    },
    async complete(model, system, messages, tools, signal) {
      signal.throwIfAborted();
      calls.push({ operation: 'complete', model, system, messages, tools });
      return completeResult;
    },
    dispose() {
      disposed.provider += 1;
    },
  };
  const gdk = {
    declarativeProviderFromJson(json) {
      creations.push({ type: 'mesh', config: JSON.parse(json) });
      return provider;
    },
    openaiProvider(apiKey, baseUrl) {
      creations.push({ type: 'openai', apiKey, baseUrl });
      return provider;
    },
  };
  const runtime = createSigDemoAgentRuntime(gdk);
  const events = [];
  return {
    ...runtime,
    calls,
    creations,
    disposed,
    events,
    run: (
      request = meshRequest,
      credentials = {},
      signal = new AbortController().signal,
      output = event => events.push(event)
    ) => runtime.runSigDemoAgent(request, credentials, signal, output),
  };
}

function outputText(events) {
  return events
    .filter(event => event.type === 'text')
    .map(event => event.text)
    .join('');
}

async function withBraveFetch(run, response = contextResponse, status = 200) {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return Response.json(response, { status });
  };
  try {
    await run(requests);
  } finally {
    globalThis.fetch = previous;
  }
}

await test('an ordinary mesh answer streams immediately using one GDK turn and no credentials', async () => {
  let unblock;
  const held = new Promise(resolve => {
    unblock = resolve;
  });
  const runtime = mockGdk([
    [
      text('Hydrogen'),
      async () => {
        await held;
        return text(' is first.');
      },
      end,
    ],
  ]);
  const credentials = {
    get apiKey() {
      throw new Error('Mesh accessed the OpenAI key');
    },
  };
  const result = runtime.run(
    {
      ...meshRequest,
      author: 'Alice',
      currentDate: '2026-10-14',
      history: [{ role: 'assistant', author: 'Sig', text: 'Earlier answer.' }],
    },
    credentials
  );
  await tick();
  assert.equal(outputText(runtime.events), 'Hydrogen');
  assert.equal(
    runtime.events.some(event => event.type === 'done'),
    false
  );
  unblock();
  await result;
  assert.equal(outputText(runtime.events), 'Hydrogen is first.');
  assert.equal(runtime.calls.length, 1);
  const context = JSON.parse(runtime.calls[0].messages[0].content[0].text);
  assert.equal(context.currentRequest.author, 'Alice');
  assert.equal(context.currentRequest.text, meshRequest.prompt);
  assert.equal(context.recentHistory[0].role, 'assistant');
  assert.ok(
    runtime.calls[0].system.includes('Answer only currentRequest.text')
  );
  assert.deepEqual(runtime.calls[0].model.requestHeaders, {
    'x-mesh-target': route.targetNodeId,
  });
  assert.equal(runtime.creations[0].config.requires_auth, false);
  assert.equal(runtime.creations[0].config.api_key_env, '');
  assert.deepEqual(runtime.disposed, { provider: 1, streams: 1 });
});

await test('native search replays tool IDs, opaque metadata and thinking with two model turns', async () => {
  await withBraveFetch(async requests => {
    const metadata = JSON.stringify({
      extra_content: { google: { thought_signature: 'opaque-signature' } },
    });
    const runtime = mockGdk([
      [
        { kind: 'ThinkingChunk', thinking: 'hidden ', signature: '' },
        { kind: 'ThinkingChunk', thinking: 'reasoning', signature: 'signed' },
        { kind: 'RedactedThinkingChunk', data: 'opaque-redacted' },
        tool('Goose Rust SDK', 'native-id', { providerMetadataJson: metadata }),
        end,
      ],
      [
        text('The SDK supports tools: https://goose-docs.ai/docs/gdk/sdk/'),
        end,
      ],
    ]);
    await runtime.run(
      { ...meshRequest, prompt: 'Search for the Goose Rust SDK' },
      { braveApiKey: 'brave-test-key' }
    );
    assert.equal(runtime.calls.length, 2);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].options.headers['X-Subscription-Token'],
      'brave-test-key'
    );
    assert.ok(!JSON.stringify(runtime.calls).includes('brave-test-key'));
    const assistant = runtime.calls[1].messages.find(
      message => message.role === 'Assistant'
    );
    assert.deepEqual(assistant.content[0], {
      kind: 'Thinking',
      thinking: 'hidden reasoning',
      signature: 'signed',
    });
    assert.deepEqual(assistant.content[1], {
      kind: 'RedactedThinking',
      data: 'opaque-redacted',
    });
    const nativeTool = assistant.content.find(
      content => content.kind === 'ToolRequest'
    );
    assert.equal(nativeTool.id, 'native-id');
    assert.equal(nativeTool.providerMetadataJson, metadata);
    const result = runtime.calls[1].messages.find(
      message => message.role === 'Tool'
    ).content[0];
    assert.equal(result.id, 'native-id');
    assert.equal(result.success, true);
    assert.equal(
      runtime.events.filter(event => event.status === 'searching').length,
      1
    );
    assert.ok(!outputText(runtime.events).includes('reasoning'));
    assert.ok(
      runtime.calls.every(call => call.tools[0].name === 'brave_web_search')
    );
    assert.deepEqual(runtime.disposed, { provider: 1, streams: 2 });
  });
});

const observed =
  '<tool_call>\n<function=search>\n<function_name>google_search</function_name>\n<function_arguments>{"query":"movies playing in West Vancouver cinemas October 2026"}</function_arguments>\n</function>\n</tool_call>';
const canonical =
  '<tool_call>{"name":"brave_web_search","arguments":{"query":"Rust SDK","freshness":"pm"}}</tool_call>';

await test('observed text call is hidden, decoded locally, and invokes no planning turn', async () => {
  await withBraveFetch(async requests => {
    const runtime = mockGdk([
      [text('<tool_'), text(observed.slice('<tool_'.length)), end],
      [text('Found with Brave.'), end],
    ]);
    await runtime.run(meshRequest, { braveApiKey: 'brave-test-key' });
    assert.equal(runtime.calls.length, 2);
    assert.equal(requests.length, 1);
    assert.equal(outputText(runtime.events), 'Found with Brave.');
    const call = runtime.calls[1].messages.find(
      message => message.role === 'Assistant'
    ).content[0];
    assert.equal(call.kind, 'ToolRequest');
    assert.equal(call.name, 'brave_web_search');
  });
});

await test('native calls take precedence over duplicate raw frames and repeated complete chunks', async () => {
  await withBraveFetch(async requests => {
    const call = tool('Rust SDK');
    const runtime = mockGdk([
      [text(canonical), call, { ...call }, end],
      [text('Found.'), end],
    ]);
    await runtime.run(meshRequest, { braveApiKey: 'brave-test-key' });
    assert.equal(requests.length, 1);
    assert.equal(runtime.calls.length, 2);
    assert.equal(outputText(runtime.events), 'Found.');
  });
});

await test('unknown or malformed tools fail without a search or extra paid model turn', async () => {
  await withBraveFetch(async requests => {
    for (const chunks of [
      [tool('SDK', 'tool-1', { name: 'shell' }), end],
      [
        tool('SDK', 'tool-1', {
          argumentsJson: '{"query":"SDK","url":"https://example.com"}',
        }),
        end,
      ],
      [text('<tool_call>unreadable</tool_call>'), end],
      [
        text(
          '<tool_call>{"name":"shell","arguments":{"query":"SDK"}}</tool_call>'
        ),
        end,
      ],
    ]) {
      const runtime = mockGdk([chunks]);
      // Keep this group isolated from the shared fetch fixture's next case.
      // oxlint-disable-next-line no-await-in-loop
      await assert.rejects(
        runtime.run(meshRequest, { braveApiKey: 'brave-test-key' }),
        /web search|unavailable tool/
      );
      assert.equal(runtime.calls.length, 1);
      assert.equal(outputText(runtime.events), '');
      assert.deepEqual(runtime.disposed, { provider: 1, streams: 1 });
    }
    assert.equal(requests.length, 0);
  });
});

await test('two actual searches use three model turns and never start a fourth', async () => {
  for (const finalIsTool of [false, true]) {
    // Each case replaces global fetch with its own ordered response fixture.
    // oxlint-disable-next-line no-await-in-loop
    await withBraveFetch(async requests => {
      const runtime = mockGdk([
        [tool('SDK docs', 'one'), end],
        [tool('SDK examples', 'two'), end],
        finalIsTool
          ? [tool('Forbidden third query', 'three'), end]
          : [text('The sources agree.'), end],
      ]);
      const result = runtime.run(meshRequest, {
        braveApiKey: 'brave-test-key',
      });
      if (finalIsTool) await assert.rejects(result, /web search limit/);
      else await result;
      assert.equal(runtime.calls.length, 3);
      assert.equal(requests.length, 2);
      assert.equal(
        runtime.calls[2].messages.filter(message => message.role === 'Tool')
          .length,
        2
      );
      assert.equal(
        outputText(runtime.events),
        finalIsTool ? '' : 'The sources agree.'
      );
    });
  }
});

await test('a repeated search is not followed by a repair inference turn', async () => {
  await withBraveFetch(async requests => {
    const runtime = mockGdk([
      [tool('SDK', 'one'), end],
      [tool('SDK', 'two'), end],
    ]);
    await assert.rejects(
      runtime.run(meshRequest, { braveApiKey: 'brave-test-key' }),
      /repeated a web search/
    );
    assert.equal(runtime.calls.length, 2);
    assert.equal(requests.length, 1);
  });
});

await test('ChatGPT uses the supplied constructor credential and native Responses web search only', async () => {
  await withBraveFetch(async requests => {
    const runtime = mockGdk([[text('A native OpenAI response.'), end]]);
    const credentials = {
      apiKey: 'openai-synthetic-private-key',
      get braveApiKey() {
        throw new Error('ChatGPT accessed Brave');
      },
    };
    await runtime.run(
      { provider: 'chatgpt', prompt: 'Search the latest SDK docs' },
      credentials
    );
    assert.equal(runtime.creations[0].type, 'openai');
    assert.equal(runtime.creations[0].apiKey, credentials.apiKey);
    assert.equal(runtime.calls[0].model.modelName, 'gpt-6-luna');
    assert.deepEqual(JSON.parse(runtime.calls[0].model.requestParamsJson), {
      thinking_effort: 'off',
      store: false,
      web_search: true,
      max_tool_calls: 2,
    });
    assert.deepEqual(runtime.calls[0].tools, []);
    assert.ok(!JSON.stringify(runtime.calls).includes(credentials.apiKey));
    assert.equal(requests.length, 0);
    assert.equal(runtime.calls.length, 1);
  });
});

await test('free warmup uses one constant 40-token native completion and ignores tool suggestions', async () => {
  await withBraveFetch(async requests => {
    const runtime = mockGdk([], {
      content: [
        {
          kind: 'ToolRequest',
          name: 'brave_web_search',
          id: 'never-run',
          argumentsJson: '{"query":"private chat"}',
        },
      ],
      messageJson: '{}',
      usage: null,
    });
    const timings = [];
    await runtime.warmSigDemoMesh(route, new AbortController().signal, event =>
      timings.push(event)
    );
    assert.equal(runtime.calls.length, 1);
    assert.equal(runtime.calls[0].operation, 'complete');
    assert.equal(runtime.calls[0].model.maxTokens, 40);
    assert.equal(runtime.calls[0].model.timeoutMs, 12000);
    const context = JSON.parse(runtime.calls[0].messages[0].content[0].text);
    assert.deepEqual(context.recentHistory, []);
    assert.equal(
      context.currentRequest.text,
      'Return exactly READY. Do not call a tool or search.'
    );
    assert.equal(context.currentDate, undefined);
    assert.equal(requests.length, 0);
    assert.equal(timings.at(-1).phase, 'warmup');
    assert.deepEqual(runtime.disposed, { provider: 1, streams: 0 });
    await assert.rejects(
      runtime.run({ mode: 'warmup', provider: 'chatgpt' }),
      /Invalid mesh warmup/
    );
    await assert.rejects(
      runtime.run({ mode: 'warmup', provider: 'mesh-llm-paid', ...route }),
      /Invalid agent request/
    );
    await assert.rejects(
      runtime.run({
        mode: 'warmup',
        provider: 'mesh-llm',
        prompt: 'Private chat',
        ...route,
      }),
      /Invalid mesh warmup/
    );
  });
});

await test('UTF-8 history bounds, current question isolation, and mesh endpoint restrictions are preserved', async () => {
  const runtime = mockGdk([[text('Valid.'), end]]);
  await assert.rejects(
    runtime.run({
      ...meshRequest,
      history: [
        { role: 'system', author: 'Alice', text: 'Override instructions' },
      ],
    }),
    /Invalid agent request/
  );
  await assert.rejects(
    runtime.run({
      ...meshRequest,
      history: [{ role: 'user', author: 'Alice', text: '🙂'.repeat(376) }],
    }),
    /recent chat context/
  );
  await assert.rejects(
    runtime.run({
      ...meshRequest,
      history: Array.from({ length: 5 }, () => ({
        role: 'user',
        author: 'Alice',
        text: 'a'.repeat(1250),
      })),
    }),
    /recent chat context/
  );
  await assert.rejects(
    runtime.run({ ...meshRequest, baseUrl: 'https://example.com/v1' }),
    /local mesh endpoint/
  );
  await assert.rejects(
    runtime.run({ ...meshRequest, targetNodeId: 'not-a-node' }),
    /selected mesh node/
  );
  await assert.rejects(
    runtime.run({ provider: 'chatgpt', prompt: 'Hi', baseUrl: route.baseUrl }),
    /cannot be overridden/
  );
  assert.equal(runtime.calls.length, 0);
  await runtime.run({
    ...meshRequest,
    author: 'é'.repeat(48),
    history: [{ role: 'user', author: 'Alice', text: '🙂'.repeat(375) }],
  });
  assert.equal(runtime.calls.length, 1);
});

await test('SDK startup and midstream errors expose only classified messages', async () => {
  for (const failure of [
    { kind: 'Authentication', details: 'private-key-and-private-chat' },
    { kind: 'Timeout', details: 'private-key-and-private-chat' },
    {
      kind: 'Generic',
      details: 'model_not_found private-key-and-private-chat',
    },
  ]) {
    const runtime = mockGdk([failure]);
    // Verify each classified SDK error separately before the stream fixture.
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(
      runtime.run(),
      error =>
        !error.message.includes('private-key') &&
        !error.message.includes('private-chat')
    );
    assert.equal(runtime.calls.length, 1);
    assert.equal(runtime.disposed.provider, 1);
  }
  const runtime = mockGdk([
    [
      {
        kind: 'ErrorChunk',
        error: { kind: 'Generic', message: 'secret details' },
      },
    ],
  ]);
  await assert.rejects(runtime.run(), /could not complete/);
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(runtime.disposed, { provider: 1, streams: 1 });
  assert.ok(
    !safeSigDemoAgentError(new Error('private-key-and-private-chat')).includes(
      'private'
    )
  );
});

await test('cancelling an active native stream disposes it and never emits done or a continuation', async () => {
  let cancellationCount = 0;
  const runtime = mockGdk([
    [
      text('Visible reply'),
      signal =>
        new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              cancellationCount += 1;
              reject(new DOMException('secret native details', 'AbortError'));
            },
            { once: true }
          )
        ),
    ],
  ]);
  const controller = new AbortController();
  const run = runtime.run(meshRequest, {}, controller.signal);
  await tick();
  assert.equal(outputText(runtime.events), 'Visible reply');
  controller.abort();
  await assert.rejects(run, /request was cancelled/);
  assert.equal(cancellationCount, 1);
  assert.equal(runtime.calls.length, 1);
  assert.equal(
    runtime.events.some(event => event.type === 'done'),
    false
  );
  assert.deepEqual(runtime.disposed, { provider: 1, streams: 1 });
});

await test('the whole request deadline cancels the native future and cleans up', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = mockGdk([
    [
      signal =>
        new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () =>
              reject(new DOMException('native timeout details', 'AbortError')),
            { once: true }
          )
        ),
    ],
  ]);
  const run = runtime.run();
  await tick();
  context.mock.timers.tick(120000);
  await assert.rejects(run, /request timed out/);
  assert.deepEqual(runtime.disposed, { provider: 1, streams: 1 });
});

await test('tool text frames remain hidden at every boundary while literal examples never invoke', () => {
  for (const frame of [observed, canonical]) {
    for (let split = 0; split <= frame.length; split += 1) {
      const filter = new ToolTextFilter();
      assert.equal(filter.push(frame.slice(0, split)), '');
      assert.equal(filter.push(frame.slice(split)), '');
      const result = filter.finish();
      assert.equal(result.tail, '');
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].name, 'brave_web_search');
    }
  }
  for (const literal of [
    `The tag \`${canonical}\` is an example.`,
    `\`\`\`xml\n${canonical}\n\`\`\`\n`,
    `\`\`\`\`xml\n\`\`\`\n${canonical}\n\`\`\`\`\n`,
    `\`\`\`xml\n\`\`\`not-a-closing-fence\n${canonical}\n\`\`\`\n`,
    `\`multiline code\n${canonical}\n\``,
    `\`\`multiline code\n\`\n${canonical}\n\`\``,
    `> ${canonical}\n`,
    `    ${canonical}\n`,
    `An example: ${canonical}`,
    '{"name":"brave_web_search","arguments":{"query":"SDK"}}',
  ]) {
    const filter = new ToolTextFilter();
    let visible = '';
    for (const character of literal) visible += filter.push(character);
    const result = filter.finish();
    assert.equal(visible + result.tail, literal);
    assert.deepEqual(result.calls, []);
  }
  const oversized = new ToolTextFilter();
  assert.equal(
    oversized.push('<tool_call>' + 'é'.repeat(8192) + '</tool_call>'),
    ''
  );
  assert.throws(() => oversized.finish(), /unreadable web search/);
});

await test('Brave local HTTP transport keeps the key in a header and sanitizes errors', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"provider_error":"local-synthetic-private-key"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const brave = new BraveSearch(
      'local-synthetic-private-key',
      `http://127.0.0.1:${port}/context`
    );
    const result = await brave.search(
      { query: 'Rust SDK', freshness: 'pw' },
      new AbortController().signal
    );
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].headers['x-subscription-token'],
      'local-synthetic-private-key'
    );
    assert.equal(requests[0].body.q, 'Rust SDK');
    assert.equal(requests[0].body.maximum_number_of_tokens, 2048);
    assert.ok(
      !JSON.stringify(requests[0].body).includes('local-synthetic-private-key')
    );
    assert.deepEqual(result.sources, []);
    assert.equal(
      result.error,
      'The web search credential or API access was rejected.'
    );
    assert.ok(!JSON.stringify(result).includes('local-synthetic-private-key'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

await test('Brave result normalization and tool schema preserve UTF-8 budgets and safe source URLs', async () => {
  const response = {
    grounding: {
      generic: Array.from({ length: 5 }, (_, index) => ({
        title: '🙂'.repeat(80),
        url: `https://example.com/${index}`,
        snippets: ['🌲'.repeat(1000)],
      })),
    },
  };
  await withBraveFetch(async () => {
    const result = await new BraveSearch('brave-test-key').search(
      { query: 'Rust SDK' },
      new AbortController().signal
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 6000);
    assert.equal(result.sources.length, 5);
    assert.ok(
      result.sources.every(source => Buffer.byteLength(source.text) <= 1000)
    );
  }, response);
  assert.equal(truncateUtf8('a🙂b', 4), 'a');
  assert.throws(
    () => parseSearchArguments({ query: 'a '.repeat(76) }),
    /invalid or too long/
  );
  assert.throws(
    () => parseSearchArguments({ query: 'news', freshness: 'header\r\nvalue' }),
    /freshness filter/
  );
  assert.throws(
    () =>
      parseSearchArguments({ query: 'news', endpoint: 'https://example.com' }),
    /invalid web search arguments/
  );
});
