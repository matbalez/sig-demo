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
import type {
  SigDemoMeshCatalogResultType,
  SigDemoMeshProviderType,
} from '../types/SigDemoMesh.std.ts';

const log = createLogger('sig demo inference');

function getMeshSelection(provider: SigDemoInferenceProviderType): string {
  if (provider === 'chatgpt') {
    return '';
  }
  return itemStorage.get(
    provider === 'mesh-llm'
      ? 'sigDemoMeshFreeSelection'
      : 'sigDemoMeshPaidSelection',
    ''
  );
}

/** Discovery/status only: this never submits an inference or funds a wallet. */
export async function getSigDemoMeshCatalog(
  provider: SigDemoMeshProviderType
): Promise<SigDemoMeshCatalogResultType> {
  if (!window.SignalContext.config.sigDemoEnabled) {
    return { ok: false, error: 'Mesh selection is available in the demo.' };
  }
  try {
    return await ipcRenderer.invoke('sig-demo-mesh:catalog', { provider });
  } catch {
    return { ok: false, error: 'The mesh catalog could not be refreshed.' };
  }
}

/** Sync persisted selection before startup preparation and when it changes. */
export async function configureSigDemoInferenceProvider(
  provider: SigDemoInferenceProviderType,
  selectionId = getMeshSelection(provider)
): Promise<Readonly<{ ok: boolean; error?: string }>> {
  if (!window.SignalContext.config.sigDemoEnabled) {
    return {
      ok: false,
      error: 'Inference settings are available in the demo.',
    };
  }
  try {
    const result: { ok: boolean; error?: string } = await ipcRenderer.invoke(
      'sig-demo-agent:configure',
      { provider, selectionId: provider === 'chatgpt' ? '' : selectionId }
    );
    if (!result.ok) {
      // Query-time and wallet UI errors are actionable. Do not block normal
      // messaging because background mesh preparation is unavailable.
      log.info('Selected inference provider is not ready');
    }
    return result;
  } catch {
    log.info('Selected inference provider could not be prepared');
    return {
      ok: false,
      error: 'The selected model or node could not be prepared.',
    };
  }
}

/** Only a locally submitted query calls this; received messages never run GDK. */
export async function streamSigDemoAgent(
  request: Omit<SigDemoAgentRunRequestType, 'provider' | 'meshSelectionId'>,
  onText: (delta: string) => void,
  onStatus?: (status: SigDemoAgentStatusType) => void
): Promise<void> {
  if (!window.SignalContext.config.sigDemoEnabled) {
    throw new Error('Sig is available in the private demo.');
  }
  const provider = itemStorage.get(
    'sigDemoInferenceProvider',
    SIG_DEMO_DEFAULT_INFERENCE_PROVIDER
  );
  const agentRequest: SigDemoAgentRunRequestType = {
    ...request,
    provider,
    meshSelectionId: getMeshSelection(provider) || undefined,
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
