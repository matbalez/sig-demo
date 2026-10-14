// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractSigDemoAgentPrompt,
  getSigDemoAgentBubbleId,
  parseSigDemoAgentFrame,
  shouldApplySigDemoAgentFrame,
} from '../ts/util/sigDemoAgent.std.ts';

const queryId = '92daee7a-4451-4b63-a672-64bc6f7d4c48';
const nextQueryId = '03c9c63d-7c28-46c6-8a14-ff14600345f4';
const frame = {
  queryId,
  queryTimestamp: 1728880000000,
  sequence: 1,
  status: 'streaming',
  text: 'The answer',
};

await test('only an explicit Sig token invokes the helper and only query text is supplied', () => {
  assert.equal(
    extractSigDemoAgentPrompt('@sig explain encryption'),
    'explain encryption'
  );
  assert.equal(
    extractSigDemoAgentPrompt('please @SIG explain encryption'),
    'please  explain encryption'
  );
  assert.equal(extractSigDemoAgentPrompt('@sig'), '');
  for (const body of [
    undefined,
    '',
    'friend@sig.example',
    '@signal hello',
    'ordinary text',
  ]) {
    assert.equal(extractSigDemoAgentPrompt(body), undefined);
  }
});

await test('encrypted protocol frames retain timestamps and reject invalid metadata', () => {
  assert.deepEqual(
    parseSigDemoAgentFrame({
      ...frame,
      queryTimestamp: BigInt(frame.queryTimestamp),
    }),
    frame
  );
  assert.equal(parseSigDemoAgentFrame({ ...frame, sequence: -1 }), undefined);
  assert.equal(
    parseSigDemoAgentFrame({ ...frame, status: 'unknown' }),
    undefined
  );
  assert.equal(
    parseSigDemoAgentFrame({ ...frame, queryId: 'not a UUID' }),
    undefined
  );
  assert.equal(
    parseSigDemoAgentFrame({ ...frame, text: 'a'.repeat(65537) }),
    undefined
  );
});

await test('a query replaces one bubble monotonically and terminal replies resist replay', () => {
  const previous = { ...frame, sequence: 0 };
  assert.equal(shouldApplySigDemoAgentFrame(undefined, frame), true);
  assert.equal(shouldApplySigDemoAgentFrame(previous, frame), true);
  assert.equal(shouldApplySigDemoAgentFrame(frame, previous), false);
  assert.equal(shouldApplySigDemoAgentFrame(frame, frame), false);
  assert.equal(
    shouldApplySigDemoAgentFrame(frame, {
      ...frame,
      sequence: 2,
      status: 'complete',
    }),
    true
  );
  assert.equal(
    shouldApplySigDemoAgentFrame(
      { ...frame, status: 'complete' },
      { ...frame, sequence: 2 }
    ),
    false
  );
  assert.equal(
    shouldApplySigDemoAgentFrame(frame, {
      ...frame,
      queryTimestamp: frame.queryTimestamp + 1,
      sequence: 2,
    }),
    false
  );
  assert.equal(
    shouldApplySigDemoAgentFrame(frame, {
      ...frame,
      queryId: nextQueryId,
      sequence: 2,
    }),
    false
  );
});

await test('parallel queries and different real senders cannot share a response bubble', () => {
  const id = getSigDemoAgentBubbleId('conversation', 'alice', queryId);
  assert.equal(getSigDemoAgentBubbleId('conversation', 'alice', queryId), id);
  assert.notEqual(
    getSigDemoAgentBubbleId('conversation', 'alice', nextQueryId),
    id
  );
  assert.notEqual(getSigDemoAgentBubbleId('conversation', 'bob', queryId), id);
  assert.notEqual(
    getSigDemoAgentBubbleId('other conversation', 'alice', queryId),
    id
  );
});
