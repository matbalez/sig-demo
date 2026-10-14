// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { v4 as generateUuid } from 'uuid';
import type { ConversationModel } from '../models/conversations.preload.ts';
import { MessageModel } from '../models/messages.preload.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';
import { DataReader, DataWriter } from '../sql/Client.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { conversationJobQueue } from '../jobs/conversationJobQueue.preload.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import {
  extractSigDemoAgentPrompt,
  getSigDemoAgentBubbleId,
  shouldApplySigDemoAgentFrame,
} from '../util/sigDemoAgent.std.ts';
import type { SigDemoAgentFrame } from '../util/sigDemoAgent.std.ts';
import { generateMessageId } from '../util/generateMessageId.node.ts';
import { incrementMessageCounter } from '../util/incrementMessageCounter.preload.ts';
import { upgradeMessageSchema } from '../util/migrations.preload.ts';
import {
  isDirectConversation,
  isMe,
} from '../util/whatTypeOfConversation.dom.ts';
import { drop } from '../util/drop.std.ts';
import { streamSigDemoAgent } from './sigDemoAgentClient.preload.ts';
import {
  buildSigDemoAgentHistory,
  normalizeSigDemoAgentAuthor,
} from '../util/sigDemoAgentContext.std.ts';
import { hasNumberTitle } from '../util/getTitle.preload.ts';
import type { SigDemoAgentHistoryMessageType } from '../types/SigDemoAgent.std.ts';
import { createLogger } from '../logging/log.std.ts';

const log = createLogger('sig demo context');
let lastTransportTimestamp = 0;

function getHumanAuthor(message: MessageAttributesType): string {
  const contact =
    message.type === 'outgoing'
      ? window.ConversationController.getOurConversationOrThrow()
      : window.ConversationController.get(message.sourceServiceId);
  const unknown = window.SignalContext.i18n('icu:unknownContact');
  if (!contact) {
    return unknown;
  }
  // Signal's normal title fallback can be a phone number. Use display names or
  // usernames for agent context; never send a raw account or phone identifier.
  return hasNumberTitle(contact.attributes)
    ? contact.get('username') || unknown
    : contact.getTitle();
}

async function snapshotSigDemoAgentHistory(
  conversation: ConversationModel,
  query: MessageAttributesType
): Promise<Array<SigDemoAgentHistoryMessageType>> {
  if (!Number.isFinite(query.received_at) || !Number.isFinite(query.sent_at)) {
    log.warn(
      'Recent Sig context omitted because the timeline cursor is missing'
    );
    return [];
  }
  try {
    const messages = await DataReader.getOlderMessagesByConversation({
      conversationId: conversation.id,
      messageId: query.id,
      receivedAt: query.received_at,
      sentAt: query.sent_at,
      limit: 60,
      includeStoryReplies: false,
      storyId: undefined,
    });
    return buildSigDemoAgentHistory({
      messages,
      query,
      getAuthor: getHumanAuthor,
      now: Date.now(),
    });
  } catch {
    // History is optional; do not log chat text, names, IDs, or SQL errors.
    log.warn(
      'Recent Sig context could not be read; continuing without history'
    );
    return [];
  }
}

/** Call only after the normal incoming sender/group checks, or for a local query. */
export async function applySigDemoAgentResponse(
  conversation: ConversationModel,
  originAci: AciString,
  frame: SigDemoAgentFrame,
  incoming?: MessageModel
): Promise<void> {
  const id = getSigDemoAgentBubbleId(conversation.id, originAci, frame.queryId);
  let message = await getMessageById(id);
  if (message?.get('isErased') || message?.get('deletedForEveryone')) {
    return;
  }
  if (
    !shouldApplySigDemoAgentFrame(message?.get('sigDemoAgentResponse'), frame)
  ) {
    return;
  }
  const { text, ...metadata } = frame;
  const body =
    text ||
    (frame.status === 'streaming'
      ? window.SignalContext.i18n('icu:SigDemoAgent--streaming')
      : text);
  const isNew = !message;
  if (!message) {
    const ownResponse = originAci === itemStorage.user.getCheckedAci();
    const timestamp = frame.queryTimestamp + 1;
    const attributes = await upgradeMessageSchema({
      ...incoming?.attributes,
      ...generateMessageId(incrementMessageCounter()),
      id,
      conversationId: conversation.id,
      type: 'incoming',
      sourceServiceId: originAci,
      sourceDevice:
        incoming?.get('sourceDevice') ?? itemStorage.user.getCheckedDeviceId(),
      sent_at: timestamp,
      timestamp,
      received_at_ms: Date.now(),
      readStatus: ownResponse ? ReadStatus.Read : ReadStatus.Unread,
      seenStatus: ownResponse ? SeenStatus.Seen : SeenStatus.Unseen,
      expireTimer: conversation.get('expireTimer'),
      attachments: [],
      body,
      sigDemoAgentResponse: metadata,
    });
    message = window.MessageCache.register(new MessageModel(attributes));
  } else {
    message.set({ body, sigDemoAgentResponse: metadata });
  }

  // Every cumulative update replaces the same SQLCipher message row. The model
  // change updates Redux through MessageCache; no transport-frame rows are made.
  await window.MessageCache.saveMessage(message, { forceSave: isNew });
  if (isNew) {
    conversation.set({ active_at: Date.now() });
    conversation.incrementMessageCount();
    await DataWriter.updateConversation(conversation.attributes);
    await conversation.onNewMessage(message);
    conversation.throttledUpdateUnread();
  } else {
    conversation.debouncedUpdateLastMessage();
  }
}

/** This entry point is called exclusively by the local compose/send path. */
export async function invokeSigDemoAgent(
  conversation: ConversationModel,
  query: MessageAttributesType
): Promise<void> {
  if (
    !window.SignalContext.config.sigDemoEnabled ||
    query.sigDemoAgentResponse
  ) {
    return;
  }
  const prompt = extractSigDemoAgentPrompt(query.body);
  if (prompt === undefined) {
    return;
  }

  const queryId = generateUuid();
  const queryTimestamp = query.sent_at;
  const originAci = itemStorage.user.getCheckedAci();
  const author = normalizeSigDemoAgentAuthor(getHumanAuthor(query));
  // Read from SQL before adding this query's response placeholder. The snapshot
  // is bounded to this conversation and does not depend on loaded UI messages.
  const history = prompt
    ? await snapshotSigDemoAgentHistory(conversation, query)
    : [];
  let sequence = 0;
  let text = '';
  let placeholder = '';
  let lastPublishedText = '';
  let publication = Promise.resolve();
  const publish = (status: SigDemoAgentFrame['status']) => {
    const frame: SigDemoAgentFrame = {
      queryId,
      queryTimestamp,
      sequence,
      status,
      text: text || (status === 'streaming' ? placeholder : ''),
    };
    sequence += 1;
    lastPublishedText = frame.text;
    lastTransportTimestamp = Math.max(
      Date.now(),
      queryTimestamp + 1,
      lastTransportTimestamp + 1
    );
    const transportTimestamp = lastTransportTimestamp;
    const previousPublication = publication;
    publication = (async () => {
      await previousPublication;
      await conversation.queueJob('sig demo local response', () =>
        applySigDemoAgentResponse(conversation, originAci, frame)
      );
      if (
        !isDirectConversation(conversation.attributes) ||
        !isMe(conversation.attributes) ||
        window.ConversationController.doWeHaveOtherDevices()
      ) {
        await conversationJobQueue.add({
          type: 'SigDemoAgentResponse',
          conversationId: conversation.id,
          frame,
          transportTimestamp,
          revision: conversation.get('revision'),
        });
      }
    })();
    return publication;
  };

  await publish('streaming');
  const timer = setInterval(() => {
    if ((text || placeholder) !== lastPublishedText) {
      drop(publish('streaming'));
    }
  }, 500);
  try {
    if (!prompt) {
      throw new Error('Ask Sig a question after @sig.');
    }
    // Supply only this bounded, per-query snapshot; no persistent agent memory.
    await streamSigDemoAgent(
      { requestId: queryId, prompt, author, history },
      delta => {
        const hadPlaceholder = Boolean(placeholder);
        placeholder = '';
        text = (text + delta).slice(0, 65536);
        if (hadPlaceholder && text) {
          drop(publish('streaming'));
        }
      },
      status => {
        if (text) {
          return;
        }
        placeholder = window.SignalContext.i18n(
          (
            {
              responding: 'icu:SigDemoAgent--streaming',
              searching: 'icu:SigDemoAgent--searching',
            } as const
          )[status]
        );
        if (placeholder !== lastPublishedText) {
          drop(publish('streaming'));
        }
      }
    );
    clearInterval(timer);
    placeholder = '';
    await publish('complete');
  } catch (error) {
    clearInterval(timer);
    placeholder = '';
    const safeError =
      error instanceof Error
        ? error.message
        : 'Sig could not complete this reply.';
    text = text ? `${text}\n\n${safeError}`.slice(0, 65536) : safeError;
    await publish('error');
  }
}
