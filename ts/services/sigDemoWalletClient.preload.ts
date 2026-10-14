// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcRenderer } from 'electron';
import type {
  SigDemoWalletInvoiceType,
  SigDemoWalletResultType,
  SigDemoWalletSnapshotType,
} from '../types/SigDemoWallet.std.ts';

async function walletRequest<T>(
  channel: string,
  amountSats?: number
): Promise<T> {
  if (!window.SignalContext.config.sigDemoEnabled) {
    throw new Error('The wallet is available in sig demo.');
  }
  let result: SigDemoWalletResultType<T>;
  try {
    result = await ipcRenderer.invoke(channel, amountSats);
  } catch {
    throw new Error('The wallet could not be reached. Please try again.');
  }
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

export function getSigDemoWalletSnapshot(): Promise<SigDemoWalletSnapshotType> {
  return walletRequest('sig-demo-wallet:snapshot');
}

export function fundSigDemoWallet(
  amountSats: number
): Promise<SigDemoWalletInvoiceType> {
  // Each click submits once. Never automatically retry an invoice request after
  // delivery could have occurred; refresh/history can reveal its result.
  return walletRequest('sig-demo-wallet:fund', amountSats);
}
