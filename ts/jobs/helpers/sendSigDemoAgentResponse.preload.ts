// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { ContentHint } from '@signalapp/libsignal-client';
import type { ConversationModel } from '../../models/conversations.preload.ts';
import type {
  ConversationQueueJobBundle,
  SigDemoAgentResponseJobData,
} from '../conversationJobQueue.preload.ts';
import { handleMessageSend } from '../../util/handleMessageSend.preload.ts';
import { getSendOptions } from '../../util/getSendOptions.preload.ts';
import { sendToGroup } from '../../util/sendToGroup.preload.ts';
import { shouldSendToConversation } from './shouldSendToConversation.preload.ts';
import {
  handleMultipleSendErrors,
  maybeExpandErrors,
} from './handleMultipleSendErrors.std.ts';
import {
  isDirectConversation,
  isMe,
} from '../../util/whatTypeOfConversation.dom.ts';
import { isConversationUnregistered } from '../../util/isConversationUnregistered.dom.ts';
import { ourProfileKeyService } from '../../services/ourProfileKey.std.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { strictAssert } from '../../util/assert.std.ts';

export async function sendSigDemoAgentResponse(
  conversation: ConversationModel,
  {
    isFinalAttempt,
    messaging,
    shouldContinue,
    timeRemaining,
    log,
  }: ConversationQueueJobBundle,
  { frame, transportTimestamp, revision }: SigDemoAgentResponseJobData
): Promise<void> {
  if (
    !window.SignalContext.config.sigDemoEnabled ||
    !shouldContinue ||
    !shouldSendToConversation(conversation, { log })
  ) {
    return;
  }
  const ourAci = itemStorage.user.getCheckedAci();
  if (
    !isDirectConversation(conversation.attributes) &&
    (!conversation.hasMember(ourAci) ||
      (conversation.get('announcementsOnly') && !conversation.isAdmin(ourAci)))
  ) {
    return;
  }
  if (
    isDirectConversation(conversation.attributes) &&
    (isConversationUnregistered(conversation.attributes) ||
      (isMe(conversation.attributes) &&
        !window.ConversationController.doWeHaveOtherDevices()))
  ) {
    return;
  }

  const profileKey = await ourProfileKeyService.get();
  const sendOptions = await getSendOptions(conversation.attributes);
  const contentHint = ContentHint.Resendable;
  try {
    const result = await conversation.queueJob(
      'sig demo encrypted response',
      async () => {
        if (isDirectConversation(conversation.attributes)) {
          const proto = await messaging.getContentMessage({
            sigDemoAgentResponse: frame,
            profileKey,
            expireTimer: conversation.get('expireTimer'),
            expireTimerVersion: conversation.get('expireTimerVersion'),
            recipients: conversation.getRecipients(),
            timestamp: transportTimestamp,
            includePniSignatureMessage: true,
          });
          return messaging.sendIndividualProto({
            contentHint,
            serviceId: conversation.getSendTarget(),
            options: sendOptions,
            proto,
            timestamp: transportTimestamp,
            urgent: false,
          });
        }
        const groupV2 = conversation.getGroupV2Info();
        strictAssert(groupV2, 'Missing group context for Sig response');
        if (revision != null) {
          groupV2.revision = revision;
        }
        return sendToGroup({
          contentHint,
          groupSendOptions: {
            sigDemoAgentResponse: frame,
            groupV2,
            profileKey,
            expireTimer: conversation.get('expireTimer'),
            timestamp: transportTimestamp,
          },
          messageId: undefined,
          sendOptions,
          sendTarget: conversation.toSenderKeyTarget(),
          sendType: 'message',
          urgent: false,
        });
      }
    );
    await handleMessageSend(Promise.resolve(result), {
      messageIds: [],
      sendType: 'message',
    });
  } catch (error) {
    await handleMultipleSendErrors({
      errors: maybeExpandErrors(error),
      isFinalAttempt,
      log,
      timeRemaining,
      toThrow: error,
    });
  }
}
