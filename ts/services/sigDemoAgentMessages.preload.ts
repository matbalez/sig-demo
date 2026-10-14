// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { v4 as generateUuid } from 'uuid';
import type { ConversationModel } from '../models/conversations.preload.ts';
import { MessageModel } from '../models/messages.preload.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';
import { DataWriter } from '../sql/Client.preload.ts';
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

let lastTransportTimestamp = 0;

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
  let sequence = 0;
  let text = '';
  let lastPublishedText = '';
  let publication = Promise.resolve();
  const publish = (status: SigDemoAgentFrame['status']) => {
    const frame: SigDemoAgentFrame = {
      queryId,
      queryTimestamp,
      sequence,
      status,
      text,
    };
    sequence += 1;
    lastPublishedText = text;
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
    if (text !== lastPublishedText) {
      drop(publish('streaming'));
    }
  }, 500);
  try {
    if (!prompt) {
      throw new Error('Ask Sig a question after @sig.');
    }
    // No conversation history or persistent agent memory is supplied.
    await streamSigDemoAgent({ requestId: queryId, prompt }, delta => {
      text = (text + delta).slice(0, 65536);
    });
    clearInterval(timer);
    await publish('complete');
  } catch (error) {
    clearInterval(timer);
    const safeError =
      error instanceof Error
        ? error.message
        : 'Sig could not complete this reply.';
    text = text ? `${text}\n\n${safeError}`.slice(0, 65536) : safeError;
    await publish('error');
  }
}
