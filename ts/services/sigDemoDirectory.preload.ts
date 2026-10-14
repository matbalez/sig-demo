// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createLogger } from '../logging/log.std.ts';
import { DataWriter } from '../sql/Client.preload.ts';
import {
  getSigDemoDirectory,
  getSocketStatus,
} from '../textsecure/WebAPI.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { SocketStatus } from '../types/SocketStatus.std.ts';
import { drop } from '../util/drop.std.ts';
import { SECOND } from '../util/durations/constants.std.ts';
import { isBlocked } from '../util/isBlocked.preload.ts';

const log = createLogger('sig demo directory');
let refreshInProgress = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

export async function refreshSigDemoDirectory(): Promise<void> {
  if (
    !window.SignalContext.config.sigDemoEnabled ||
    refreshInProgress ||
    getSocketStatus().authenticated.status !== SocketStatus.OPEN
  ) {
    return;
  }
  const ourAci = itemStorage.user.getAci();
  if (!ourAci) {
    return;
  }

  refreshInProgress = true;
  try {
    await window.ConversationController.load();
    const { accounts } = await getSigDemoDirectory();
    await Promise.all(
      accounts
        .filter(account => account.uuid !== ourAci)
        .map(async account => {
          const { conversation, mergePromises } =
            window.ConversationController.maybeMergeContacts({
              aci: account.uuid,
              reason: 'sig demo private directory',
            });
          await Promise.all([conversation.initialPromise, ...mergePromises]);
          const firstDirectoryImport = !conversation.get('systemGivenName');
          const nameChanged =
            conversation.get('systemGivenName') !== account.displayName;

          if (nameChanged) {
            conversation.set({
              name: account.displayName,
              systemGivenName: account.displayName,
              ...(firstDirectoryImport ? { profileSharing: true } : undefined),
            });
            conversation.captureChange('sig demo directory');
            await DataWriter.updateConversation(conversation.attributes);
          }

          if (firstDirectoryImport && !isBlocked(conversation.attributes)) {
            // Use the normal encrypted Signal profile-key update job. The directory
            // only contains ACI and display name; no profile keys go through it.
            await conversation.sendProfileKeyUpdate();
          }
        })
    );
  } catch {
    // A stopped local server should not interrupt messaging or emit a roster
    // containing personal data into logs. The next interval will retry.
    log.warn('Private directory refresh failed; will retry');
  } finally {
    refreshInProgress = false;
  }
}

export function startSigDemoDirectory(): void {
  if (!window.SignalContext.config.sigDemoEnabled) {
    return;
  }
  if (!refreshTimer) {
    refreshTimer = setInterval(
      () => drop(refreshSigDemoDirectory()),
      30 * SECOND
    );
    window.addEventListener(
      'unload',
      () => {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = undefined;
        }
      },
      { once: true }
    );
  }
  drop(refreshSigDemoDirectory());
}
