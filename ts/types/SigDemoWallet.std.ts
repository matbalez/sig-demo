// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

export type SigDemoWalletTransactionType = Readonly<{
  id: string;
  paymentHash?: string;
  inbound: boolean;
  amountMsat: number;
  feeMsat: number;
  status: 'pending' | 'succeeded' | 'failed';
  createdAtMs: number;
  settledAtMs?: number;
}>;

export type SigDemoWalletSnapshotType = Readonly<{
  spendableMsat: number;
  availableForInferenceMsat: number;
  transactions: ReadonlyArray<SigDemoWalletTransactionType>;
  policy: Readonly<{
    mode: 'automatic' | 'free_only';
    dailyBudgetMsat?: number;
    spentTodayMsat: number;
    remainingDailyBudgetMsat?: number;
  }>;
}>;

export type SigDemoWalletInvoiceType = Readonly<{
  bolt11: string;
  paymentHash: string;
  amountMsat: number;
  expiresAtMs: number;
}>;

export type SigDemoWalletResultType<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: string }>;
