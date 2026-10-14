// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  SigDemoAgentEventType,
  SigDemoAgentRunRequestType,
  SigDemoAgentStatusType,
  SigDemoInferenceProviderType,
} from '../types/SigDemoAgent.std.ts';
import { SIG_DEMO_DEFAULT_INFERENCE_PROVIDER } from '../types/SigDemoAgent.std.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { drop } from '../util/drop.std.ts';
import { createLogger } from '../logging/log.std.ts';

const log = createLogger('sig demo inference');

/** Sync persisted selection before startup preparation and when it changes. */
export async function configureSigDemoInferenceProvider(
  provider: SigDemoInferenceProviderType
): Promise<void> {
  if (!window.SignalContext.config.sigDemoEnabled) {
    return;
  }
  try {
    const result: { ok: boolean; error?: string } = await ipcRenderer.invoke(
      'sig-demo-agent:configure',
      provider
    );
    if (!result.ok) {
      // Query-time and wallet UI errors are actionable. Do not block normal
      // messaging because background mesh preparation is unavailable.
      log.info('Selected inference provider is not ready');
    }
  } catch {
    log.info('Selected inference provider could not be prepared');
  }
}

/** Only a locally submitted query calls this; received messages never run GDK. */
export async function streamSigDemoAgent(
  request: Omit<SigDemoAgentRunRequestType, 'provider'>,
  onText: (delta: string) => void,
  onStatus?: (status: SigDemoAgentStatusType) => void
): Promise<void> {
  if (!window.SignalContext.config.sigDemoEnabled) {
    throw new Error('Sig is available in the private demo.');
  }
  const agentRequest: SigDemoAgentRunRequestType = {
    ...request,
    provider: itemStorage.get(
      'sigDemoInferenceProvider',
      SIG_DEMO_DEFAULT_INFERENCE_PROVIDER
    ),
  };
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      ipcRenderer.removeListener('sig-demo-agent:event', listener);
      window.removeEventListener('beforeunload', onUnload);
    };
    const finish = (error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onUnload = () => {
      ipcRenderer.send('sig-demo-agent:cancel', request.requestId);
      finish(new Error('Sig stopped when the app closed.'));
    };
    const listener = (
      _event: IpcRendererEvent,
      chunk: SigDemoAgentEventType
    ) => {
      if (chunk.requestId !== request.requestId || finished) {
        return;
      }
      if (chunk.type === 'text') {
        onText(chunk.text);
      } else if (chunk.type === 'status') {
        onStatus?.(chunk.status);
      } else if (chunk.type === 'error') {
        finish(new Error(chunk.message));
      } else if (chunk.type === 'done') {
        finish();
      }
    };
    ipcRenderer.on('sig-demo-agent:event', listener);
    window.addEventListener('beforeunload', onUnload);
    const startRequest = async () => {
      try {
        const result: { ok: boolean; error?: string } =
          await ipcRenderer.invoke('sig-demo-agent:start', agentRequest);
        if (!result.ok) {
          finish(new Error(result.error ?? 'Sig could not start.'));
        }
      } catch {
        finish(new Error('Sig could not start.'));
      }
    };
    drop(startRequest());
  });
}
