// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { MessageAttributesType } from '../model-types.d.ts';
import {
  SIG_DEMO_AGENT_AUTHOR_MAX_BYTES,
  SIG_DEMO_AGENT_HISTORY_MAX_BYTES,
  SIG_DEMO_AGENT_HISTORY_MAX_MESSAGES,
  SIG_DEMO_AGENT_HISTORY_MESSAGE_MAX_BYTES,
  type SigDemoAgentHistoryMessageType,
} from '../types/SigDemoAgent.std.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TRUNCATED_TEXT_PREFIX = '[… earlier text omitted]\n';
const truncatedTextPrefixBytes = encoder.encode(TRUNCATED_TEXT_PREFIX).length;

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte < 0xc0;
}

/** Keep display names bounded without cutting a Unicode character or using IDs. */
export function normalizeSigDemoAgentAuthor(author: string): string {
  const normalized = author.replace(/\s+/g, ' ').trim() || 'Participant';
  const bytes = encoder.encode(normalized);
  if (bytes.length <= SIG_DEMO_AGENT_AUTHOR_MAX_BYTES) {
    return normalized;
  }
  let end = SIG_DEMO_AGENT_AUTHOR_MAX_BYTES - encoder.encode('…').length;
  while (isUtf8ContinuationByte(bytes[end])) {
    end -= 1;
  }
  return `${decoder.decode(bytes.subarray(0, end))}…`;
}

function truncateTextTail(text: string, maxBytes: number): string | undefined {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  if (maxBytes <= truncatedTextPrefixBytes) {
    return undefined;
  }
  let start = bytes.length - (maxBytes - truncatedTextPrefixBytes);
  while (isUtf8ContinuationByte(bytes[start])) {
    start += 1;
  }
  if (start >= bytes.length) {
    return undefined;
  }
  return TRUNCATED_TEXT_PREFIX + decoder.decode(bytes.subarray(start));
}

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

/**
 * Select the newest useful text, then restore conversation timeline order.
 * A 6000-byte author/text budget estimates roughly 2000 tokens at UTF-8 bytes / 3;
 * it also bounds non-Latin text without splitting Unicode characters.
 */
export function buildSigDemoAgentHistory({
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
  const history: Array<SigDemoAgentHistoryMessageType> = [];
  let usedBytes = 0;
  for (const message of recent) {
    if (history.length >= SIG_DEMO_AGENT_HISTORY_MAX_MESSAGES) {
      break;
    }
    const author = message.sigDemoAgentResponse
      ? 'Sig'
      : normalizeSigDemoAgentAuthor(getAuthor(message));
    const authorBytes = encoder.encode(author).length;
    const textBudget =
      Math.min(
        SIG_DEMO_AGENT_HISTORY_MESSAGE_MAX_BYTES,
        SIG_DEMO_AGENT_HISTORY_MAX_BYTES - usedBytes
      ) - authorBytes;
    const text = truncateTextTail(message.body?.trim() ?? '', textBudget);
    if (!text) {
      break;
    }
    history.push({
      role: message.sigDemoAgentResponse ? 'assistant' : 'user',
      author,
      text,
    });
    usedBytes += authorBytes + encoder.encode(text).length;
  }
  return history.reverse();
}
