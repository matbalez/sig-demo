// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from '@storybook/react';
import { action } from '@storybook/addon-actions';
import { expect, userEvent, within } from '@storybook/test';
import { PreferencesSigDemoWallet } from './PreferencesSigDemoWallet.dom.tsx';
import type { SigDemoWalletSnapshotType } from '../types/SigDemoWallet.std.ts';

const { i18n } = window.SignalContext;
const now = Date.now();
const snapshot: SigDemoWalletSnapshotType = {
  spendableMsat: 900000,
  availableForInferenceMsat: 400000,
  policy: {
    mode: 'automatic',
    dailyBudgetMsat: 500000,
    spentTodayMsat: 100000,
    remainingDailyBudgetMsat: 400000,
  },
  transactions: [
    {
      id: 'funding-demo',
      paymentHash: 'funding-demo-hash',
      inbound: true,
      amountMsat: 1000000,
      feeMsat: 0,
      status: 'succeeded',
      createdAtMs: now - 60000,
      settledAtMs: now - 50000,
    },
    {
      id: 'inference-demo',
      inbound: false,
      amountMsat: 100000,
      feeMsat: 0,
      status: 'succeeded',
      createdAtMs: now - 30000,
    },
  ],
};

export default {
  title: 'Components/PreferencesSigDemoWallet',
  component: PreferencesSigDemoWallet,
  args: {
    i18n,
    snapshot,
    invoice: undefined,
    invoiceStatus: 'pending',
    isLoading: false,
    isFunding: false,
    error: undefined,
    copied: false,
    onRefresh: action('refreshWallet'),
    onFund: action('fundWallet'),
    onCopyInvoice: action('copyWalletInvoice'),
  },
} satisfies Meta<typeof PreferencesSigDemoWallet>;

type Story = StoryObj<typeof PreferencesSigDemoWallet>;

export const Default: Story = {};

export const Loading: Story = {
  args: { snapshot: undefined, isLoading: true },
};

export const Empty: Story = {
  args: {
    snapshot: {
      spendableMsat: 0,
      availableForInferenceMsat: 0,
      policy: { mode: 'free_only', spentTodayMsat: 0 },
      transactions: [],
    },
  },
};

export const InvoicePending: Story = {
  args: {
    invoice: {
      // Presentation fixture only; never submitted to a wallet or payment service.
      bolt11: 'lnbc10u1demoqrfixtureonlynotpayable',
      paymentHash: 'funding-demo-hash',
      amountMsat: 1000000,
      expiresAtMs: now + 3600000,
    },
  },
};

export const InvoicePaid: Story = {
  args: { ...InvoicePending.args, invoiceStatus: 'paid' },
};

export const InvoiceExpired: Story = {
  args: { ...InvoicePending.args, invoiceStatus: 'expired' },
};

export const FundingError: Story = {
  args: { error: 'fund' },
};

export const InvalidAmount: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText(i18n('icu:SigDemoWallet--amount'));
    await userEvent.clear(input);
    await userEvent.type(input, '1.5');
    await expect(
      canvas.getByRole('button', { name: i18n('icu:SigDemoWallet--fund') })
    ).toBeDisabled();
    await expect(
      canvas.getByText(i18n('icu:SigDemoWallet--invalid-amount'))
    ).toBeVisible();
  },
};
