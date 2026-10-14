// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextEncoder } from 'node:util';
import {
  buildSigDemoAgentHistory,
  normalizeSigDemoAgentAuthor,
} from '../ts/util/sigDemoAgentContext.std.ts';
import {
  SIG_DEMO_AGENT_AUTHOR_MAX_BYTES,
  SIG_DEMO_AGENT_HISTORY_MAX_BYTES,
  SIG_DEMO_AGENT_HISTORY_MESSAGE_MAX_BYTES,
} from '../ts/types/SigDemoAgent.std.ts';

const now = 1728880000000;
const query = {
  id: 'current-query',
  conversationId: 'this-chat',
  type: 'outgoing',
  body: '@sig what did we decide?',
  received_at: 100,
  sent_at: now,
  timestamp: now,
};
const getAuthor = row => (row.type === 'outgoing' ? 'Matty' : 'Alice');
function message(receivedAt, overrides = {}) {
  return {
    id: `message-${receivedAt}`,
    conversationId: query.conversationId,
    type: 'incoming',
    body: `text ${receivedAt}`,
    received_at: receivedAt,
    sent_at: now - 100 + receivedAt,
    timestamp: now - 100 + receivedAt,
    ...overrides,
  };
}
function history(messages, overrides = {}) {
  return buildSigDemoAgentHistory({
    messages,
    query,
    getAuthor,
    now,
    ...overrides,
  });
}
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

await test('context stays in one chat and strictly before the query in timeline order', () => {
  const messages = [
    message(100, { id: 'equal-cursor', sent_at: query.sent_at }),
    message(98),
    query,
    message(99, { conversationId: 'another-chat', body: 'other chat secret' }),
    message(101, { sent_at: now - 1000 }),
    message(90, { id: query.id, body: 'duplicate query' }),
    message(100, { id: 'same-received-before', sent_at: now - 1 }),
    message(97, { type: 'outgoing' }),
    message(96, { sent_at: now + 1000 }),
  ];
  assert.deepEqual(history(messages), [
    { role: 'user', author: 'Alice', text: 'text 96' },
    { role: 'user', author: 'Matty', text: 'text 97' },
    { role: 'user', author: 'Alice', text: 'text 98' },
    { role: 'user', author: 'Alice', text: 'text 100' },
  ]);
  assert.deepEqual(
    history(messages, { query: { ...query, received_at: NaN } }),
    []
  );
});

await test('only ordinary text and completed Sig replies enter context', () => {
  const sig = status => ({
    queryId: 'prior-agent-query',
    queryTimestamp: now - 1000,
    sequence: 2,
    status,
  });
  assert.deepEqual(
    history([
      message(70),
      message(71, {
        sigDemoAgentResponse: sig('complete'),
        body: 'We chose Friday.',
      }),
      message(72, {
        sigDemoAgentResponse: sig('streaming'),
        body: 'Connecting to mesh…',
      }),
      message(73, {
        sigDemoAgentResponse: sig('error'),
        body: 'No node available',
      }),
      message(74, { isErased: true }),
      message(75, { deletedForEveryone: true }),
      message(76, { isViewOnce: true }),
      message(77, { type: 'group-v2-change' }),
      message(78, { expireTimer: 1, expirationStartTimestamp: now - 1000 }),
      message(79, { attachments: [{ contentType: 'image/jpeg' }] }),
      message(80, { bodyAttachment: { contentType: 'text/plain' } }),
      message(81, { body: '   ' }),
      message(82, { storyId: 'story' }),
      message(83, { flags: 2 }),
      message(84, { errors: [{ name: 'SendError' }] }),
      message(85, { sticker: {} }),
      message(86, { contact: [{}] }),
      message(87, { payment: {} }),
      message(88, { poll: {} }),
      message(89, { isTapToViewInvalid: true }),
    ]),
    [
      { role: 'user', author: 'Alice', text: 'text 70' },
      { role: 'assistant', author: 'Sig', text: 'We chose Friday.' },
    ]
  );
  assert.equal(
    history([message(90, { expireTimer: 30, expirationStartTimestamp: now })])
      .length,
    1
  );
  assert.equal(history([message(90, { expireTimer: 30 })]).length, 1);
});

await test('selects the newest twelve useful messages and restores chronological order', () => {
  const messages = Array.from({ length: 18 }, (_, index) => message(index + 1));
  const selected = history(messages.reverse());
  assert.equal(selected.length, 12);
  assert.deepEqual(
    selected.map(entry => entry.text),
    Array.from({ length: 12 }, (_, index) => `text ${index + 7}`)
  );
  assert.deepEqual(
    messages.map(entry => entry.received_at),
    Array.from({ length: 18 }, (_, index) => 18 - index)
  );
});

await test('UTF-8 budget includes authors and keeps long-message tails visibly truncated', () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index + 1, {
      body: `Old opening ${'🪿漢'.repeat(600)} recent ending ${index + 1}`,
    })
  );
  const selected = history(messages, { getAuthor: () => '🪿'.repeat(100) });
  assert.equal(selected.length, 4);
  assert.deepEqual(
    selected.map(entry => entry.text.match(/recent ending (\d+)$/)?.[1]),
    ['7', '8', '9', '10']
  );
  let totalBytes = 0;
  for (const entry of selected) {
    const bytes = byteLength(entry.author) + byteLength(entry.text);
    assert.ok(bytes <= SIG_DEMO_AGENT_HISTORY_MESSAGE_MAX_BYTES);
    assert.ok(byteLength(entry.author) <= SIG_DEMO_AGENT_AUTHOR_MAX_BYTES);
    assert.ok(entry.text.startsWith('[… earlier text omitted]\n'));
    assert.ok(!entry.text.includes('Old opening'));
    assert.ok(!entry.text.includes('�'));
    assert.ok(!entry.author.includes('�'));
    totalBytes += bytes;
  }
  assert.ok(totalBytes <= SIG_DEMO_AGENT_HISTORY_MAX_BYTES);
  assert.equal(normalizeSigDemoAgentAuthor('  Alice\nSmith  '), 'Alice Smith');
  assert.equal(normalizeSigDemoAgentAuthor(''), 'Participant');
});
