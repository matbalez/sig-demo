// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { MessageAttributesType } from '../model-types.d.ts';
import {
  SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES,
  SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES,
  type SigDemoAgentHistoryMessageType,
} from '../types/SigDemoAgent.std.ts';

const encoder = new TextEncoder();

function compareTimeline(
  left: Pick<MessageAttributesType, 'received_at' | 'sent_at'>,
  right: Pick<MessageAttributesType, 'received_at' | 'sent_at'>
): number {
  return left.received_at - right.received_at || left.sent_at - right.sent_at;
}

function isUsefulContextMessage(
  message: MessageAttributesType,
  query: MessageAttributesType,
  now: number
): boolean {
  if (
    message.conversationId !== query.conversationId ||
    message.id === query.id ||
    !Number.isFinite(message.received_at) ||
    !Number.isFinite(message.sent_at) ||
    compareTimeline(message, query) >= 0 ||
    (message.type !== 'incoming' && message.type !== 'outgoing') ||
    message.isErased ||
    message.deletedForEveryone ||
    message.isViewOnce ||
    message.isTapToViewInvalid ||
    message.storyId ||
    message.flags ||
    message.errors?.length ||
    message.attachments?.length ||
    message.bodyAttachment ||
    message.sticker ||
    message.contact?.length ||
    message.payment ||
    message.giftBadge ||
    message.poll ||
    !message.body?.trim()
  ) {
    return false;
  }
  if (
    message.sigDemoAgentResponse &&
    message.sigDemoAgentResponse.status !== 'complete'
  ) {
    return false;
  }
  return !(
    typeof message.expireTimer === 'number' &&
    message.expireTimer > 0 &&
    typeof message.expirationStartTimestamp === 'number' &&
    message.expirationStartTimestamp + message.expireTimer * 1000 <= now
  );
}

/** Collect eligible Signal records; the native agent selects its context window. */
export function collectSigDemoAgentHistoryCandidates({
  messages,
  query,
  getAuthor,
  now,
}: Readonly<{
  messages: ReadonlyArray<MessageAttributesType>;
  query: MessageAttributesType;
  getAuthor: (message: MessageAttributesType) => string;
  now: number;
}>): Array<SigDemoAgentHistoryMessageType> {
  if (!Number.isFinite(query.received_at) || !Number.isFinite(query.sent_at)) {
    return [];
  }
  const recent = messages
    .filter(message => isUsefulContextMessage(message, query, now))
    .sort(
      (left, right) =>
        compareTimeline(right, left) || right.id.localeCompare(left.id)
    );
  const candidates: Array<SigDemoAgentHistoryMessageType> = [];
  let usedBytes = 0;
  for (const message of recent) {
    if (candidates.length >= SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES) {
      break;
    }
    const author = message.sigDemoAgentResponse ? 'Sig' : getAuthor(message);
    const text = message.body ?? '';
    const bytes = encoder.encode(author).length + encoder.encode(text).length;
    // This bounds IPC transport only. Rust owns trimming and prompt budgets.
    if (usedBytes + bytes > SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES) {
      break;
    }
    candidates.push({
      id: message.id,
      role: message.sigDemoAgentResponse ? 'assistant' : 'user',
      author,
      text,
    });
    usedBytes += bytes;
  }
  return candidates.reverse();
}
