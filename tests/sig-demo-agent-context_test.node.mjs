// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextEncoder } from 'node:util';
import { collectSigDemoAgentHistoryCandidates } from '../ts/util/sigDemoAgentContext.std.ts';
import {
  SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES,
  SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES,
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
  return collectSigDemoAgentHistoryCandidates({
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
    { id: 'message-96', role: 'user', author: 'Alice', text: 'text 96' },
    { id: 'message-97', role: 'user', author: 'Matty', text: 'text 97' },
    { id: 'message-98', role: 'user', author: 'Alice', text: 'text 98' },
    {
      id: 'same-received-before',
      role: 'user',
      author: 'Alice',
      text: 'text 100',
    },
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
      { id: 'message-70', role: 'user', author: 'Alice', text: 'text 70' },
      {
        id: 'message-71',
        role: 'assistant',
        author: 'Sig',
        text: 'We chose Friday.',
      },
    ]
  );
  assert.equal(
    history([message(90, { expireTimer: 30, expirationStartTimestamp: now })])
      .length,
    1
  );
  assert.equal(history([message(90, { expireTimer: 30 })]).length, 1);
});

await test('stable record ids distinguish identical text and remain stable after edits', () => {
  const first = message(80, { id: 'first-record', body: 'Same text' });
  const second = message(81, { id: 'second-record', body: 'Same text' });
  assert.deepEqual(
    history([second, first]).map(entry => ({ id: entry.id, text: entry.text })),
    [
      { id: 'first-record', text: 'Same text' },
      { id: 'second-record', text: 'Same text' },
    ]
  );
  assert.deepEqual(
    history([{ ...first, body: 'Edited text' }]).map(entry => ({
      id: entry.id,
      text: entry.text,
    })),
    [{ id: 'first-record', text: 'Edited text' }]
  );
  assert.equal(first.body, 'Same text');
});

await test('each snapshot removes records that have since expired or been deleted', () => {
  const expiring = message(80, {
    expireTimer: 30,
    expirationStartTimestamp: now,
  });
  const retained = message(81);
  assert.deepEqual(
    history([expiring, retained]).map(entry => entry.id),
    ['message-80', 'message-81']
  );
  assert.deepEqual(
    history([expiring, retained], { now: now + 30_000 }).map(entry => entry.id),
    ['message-81']
  );
  assert.deepEqual(
    history([{ ...expiring, deletedForEveryone: true }, retained]).map(
      entry => entry.id
    ),
    ['message-81']
  );
});

await test('collects chronological candidates without applying the native twelve-message window', () => {
  const messages = Array.from({ length: 70 }, (_, index) => message(index + 1));
  const selected = history(messages.reverse());
  assert.equal(selected.length, SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES);
  assert.deepEqual(
    selected.map(entry => entry.text),
    Array.from({ length: 60 }, (_, index) => `text ${index + 11}`)
  );
  assert.equal(messages[0].received_at, 70);
});

await test('passes untrimmed Unicode text and names to Rust while bounding IPC bytes', () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index + 1, {
      body: `Old opening ${'🪿漢'.repeat(600)} recent ending ${index + 1}`,
    })
  );
  const selected = history(messages, { getAuthor: () => '🪿'.repeat(100) });
  assert.equal(selected.length, 10);
  assert.ok(selected.every(entry => entry.text.startsWith('Old opening')));
  assert.ok(selected.every(entry => entry.author === '🪿'.repeat(100)));
  assert.ok(
    selected.reduce((bytes, entry) => bytes + byteLength(entry.text), 0) > 6000
  );
  const large = history(
    Array.from({ length: 40 }, (_, index) =>
      message(index + 1, {
        body: 'x'.repeat(150000),
      })
    )
  );
  assert.ok(large.length < 40);
  assert.ok(
    large.reduce(
      (bytes, entry) =>
        bytes + byteLength(entry.author) + byteLength(entry.text),
      0
    ) <= SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES
  );
  assert.ok(large.every(entry => entry.text.length === 150000));
});
