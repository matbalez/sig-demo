// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { useId, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { AxoButton } from '../axo/AxoButton.dom.tsx';
import { AxoPanel } from '../axo/AxoPanel.dom.tsx';
import { AxoList } from '../axo/items/AxoList.dom.tsx';
import { AxoItem } from '../axo/items/AxoItem.dom.tsx';
import { AxoTextItem } from '../axo/items/AxoTextItem.dom.tsx';
import { tw } from '../axo/tw.dom.tsx';
import type { LocalizerType } from '../types/Util.std.ts';
import type {
  SigDemoWalletInvoiceType,
  SigDemoWalletSnapshotType,
} from '../types/SigDemoWallet.std.ts';
import { QrCode } from './QrCode.dom.tsx';
import { Input } from './Input.dom.tsx';

export type SigDemoWalletInvoiceStatusType =
  | 'pending'
  | 'paid'
  | 'expired'
  | 'failed';

export type PropsType = Readonly<{
  i18n: LocalizerType;
  snapshot: SigDemoWalletSnapshotType | undefined;
  invoice: SigDemoWalletInvoiceType | undefined;
  invoiceStatus: SigDemoWalletInvoiceStatusType;
  isLoading: boolean;
  isFunding: boolean;
  error: 'snapshot' | 'fund' | 'copy' | undefined;
  copied: boolean;
  onRefresh: () => void;
  onFund: (amountSats: number) => void;
  onCopyInvoice: () => void;
}>;

function WalletSection({
  title,
  children,
  isList = true,
}: Readonly<{
  title: string;
  children: ReactNode;
  isList?: boolean;
}>): JSX.Element {
  return (
    <AxoList.Root>
      <AxoList.Header>
        <AxoList.Label>{title}</AxoList.Label>
      </AxoList.Header>
      <AxoList.Body>
        {isList ? <AxoItem.Group>{children}</AxoItem.Group> : children}
      </AxoList.Body>
    </AxoList.Root>
  );
}

export function PreferencesSigDemoWallet({
  i18n,
  snapshot,
  invoice,
  invoiceStatus,
  isLoading,
  isFunding,
  error,
  copied,
  onRefresh,
  onFund,
  onCopyInvoice,
}: PropsType): JSX.Element {
  const amountId = useId();
  const [amount, setAmount] = useState('1000');
  const amountSats = Number(amount);
  const isValidAmount =
    /^[1-9]\d*$/.test(amount) &&
    Number.isSafeInteger(amountSats * 1000) &&
    amountSats > 0;
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.getLocale(), { maximumFractionDigits: 0 }),
    [i18n]
  );
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.getLocale(), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [i18n]
  );
  const formatAmount = (amountMsat: number): string => {
    if (amountMsat > 0 && amountMsat < 1000) {
      return i18n('icu:SigDemoWallet--less-than-one');
    }
    return `₿${numberFormatter.format(Math.floor(amountMsat / 1000))}`;
  };
  const transactions = useMemo(
    () =>
      [...(snapshot?.transactions ?? [])].sort(
        (left, right) => right.createdAtMs - left.createdAtMs
      ),
    [snapshot]
  );
  const transactionStatusLabels = {
    succeeded: i18n('icu:SigDemoWallet--succeeded'),
    failed: i18n('icu:SigDemoWallet--failed'),
    pending: i18n('icu:SigDemoWallet--pending'),
  };

  let errorText: string | undefined;
  if (error === 'snapshot') {
    errorText = i18n('icu:SigDemoWallet--load-error');
  } else if (error === 'fund') {
    errorText = i18n('icu:SigDemoWallet--fund-error');
  } else if (error === 'copy') {
    errorText = i18n('icu:SigDemoWallet--copy-error');
  }

  let invoiceStatusText: string;
  if (invoiceStatus === 'paid') {
    invoiceStatusText = i18n('icu:SigDemoWallet--invoice-paid');
  } else if (invoiceStatus === 'expired') {
    invoiceStatusText = i18n('icu:SigDemoWallet--invoice-expired');
  } else if (invoiceStatus === 'failed') {
    invoiceStatusText = i18n('icu:SigDemoWallet--invoice-failed');
  } else {
    invoiceStatusText = i18n('icu:SigDemoWallet--invoice-pending');
  }

  return (
    <AxoPanel.Root>
      <AxoPanel.Header>
        <AxoPanel.Label>{i18n('icu:SigDemoWallet--title')}</AxoPanel.Label>
      </AxoPanel.Header>
      <AxoPanel.Content>
        <AxoList.Group>
          <div className={tw('flex items-center justify-between gap-3 px-4')}>
            <p className={tw('type-body-small text-secondary')}>
              {i18n('icu:SigDemoWallet--description')}
            </p>
            <AxoButton.Root
              size="sm"
              variant="subtle-secondary"
              disabled={isLoading}
              onClick={onRefresh}
            >
              {i18n('icu:SigDemoWallet--refresh')}
            </AxoButton.Root>
          </div>
          {errorText && (
            <p
              role="alert"
              className={tw('px-4 type-body-small text-destructive')}
            >
              {errorText}
            </p>
          )}
          {!snapshot && (
            <p
              role="status"
              className={tw('px-4 type-body-small text-secondary')}
            >
              {isLoading
                ? i18n('icu:SigDemoWallet--loading')
                : i18n('icu:SigDemoWallet--unavailable')}
            </p>
          )}
          {snapshot && (
            <WalletSection title={i18n('icu:SigDemoWallet--balance')}>
              <AxoTextItem.Root
                label={i18n('icu:SigDemoWallet--spendable')}
                value={formatAmount(snapshot.spendableMsat)}
              />
              {snapshot.policy.mode === 'automatic' && (
                <>
                  <AxoTextItem.Root
                    label={i18n('icu:SigDemoWallet--available-for-inference')}
                    value={formatAmount(snapshot.availableForInferenceMsat)}
                  />
                  {snapshot.policy.dailyBudgetMsat !== undefined && (
                    <AxoTextItem.Root
                      label={i18n('icu:SigDemoWallet--daily-budget')}
                      value={formatAmount(snapshot.policy.dailyBudgetMsat)}
                      description={i18n('icu:SigDemoWallet--automatic-policy')}
                    />
                  )}
                  {snapshot.policy.remainingDailyBudgetMsat !== undefined && (
                    <AxoTextItem.Root
                      label={i18n('icu:SigDemoWallet--remaining-budget')}
                      value={formatAmount(
                        snapshot.policy.remainingDailyBudgetMsat
                      )}
                    />
                  )}
                </>
              )}
              {snapshot.policy.mode === 'free_only' && (
                <AxoTextItem.Root
                  label={i18n('icu:SigDemoWallet--free-policy')}
                  description={i18n('icu:SigDemoWallet--paid-description')}
                />
              )}
            </WalletSection>
          )}
          <WalletSection
            title={i18n('icu:SigDemoWallet--fund-title')}
            isList={false}
          >
            <div className={tw('flex flex-col gap-3 px-4 py-3')}>
              <label htmlFor={amountId} className={tw('type-body-medium')}>
                {i18n('icu:SigDemoWallet--amount')}
              </label>
              <Input
                id={amountId}
                i18n={i18n}
                placeholder="1000"
                value={amount}
                disabled={isFunding}
                disableSpellcheck
                maxLengthCount={15}
                onChange={setAmount}
                aria-invalid={!isValidAmount}
              />
              {!isValidAmount && (
                <p className={tw('m-0 type-body-small text-destructive')}>
                  {i18n('icu:SigDemoWallet--invalid-amount')}
                </p>
              )}
              <AxoButton.Root
                size="md"
                variant="strong-primary"
                disabled={!snapshot || !isValidAmount || isFunding}
                onClick={() => onFund(amountSats)}
              >
                {isFunding
                  ? i18n('icu:SigDemoWallet--creating-invoice')
                  : i18n('icu:SigDemoWallet--fund')}
              </AxoButton.Root>
            </div>
            {invoice && (
              <div className={tw('flex flex-col items-center gap-3 px-4 pb-4')}>
                <p className={tw('m-0 type-body-medium font-semibold')}>
                  {formatAmount(invoice.amountMsat)}
                </p>
                <p role="status" className={tw('m-0 type-body-small')}>
                  {invoiceStatusText}
                </p>
                {invoiceStatus === 'pending' && (
                  <>
                    <div className={tw('rounded-lg bg-white p-3')}>
                      <QrCode
                        alt={i18n('icu:SigDemoWallet--invoice-qr')}
                        data={invoice.bolt11.toUpperCase()}
                        className={tw('block size-52')}
                      />
                    </div>
                    <p className={tw('m-0 type-body-small text-secondary')}>
                      {i18n('icu:SigDemoWallet--invoice-expires', {
                        time: dateFormatter.format(invoice.expiresAtMs),
                      })}
                    </p>
                    <textarea
                      aria-label={i18n('icu:SigDemoWallet--invoice')}
                      className={tw(
                        'w-full resize-none rounded-lg border border-primary bg-surface-primary p-2 type-body-small text-primary'
                      )}
                      value={invoice.bolt11}
                      readOnly
                      rows={3}
                    />
                    <AxoButton.Root
                      size="sm"
                      variant="subtle-secondary"
                      onClick={onCopyInvoice}
                    >
                      {copied
                        ? i18n('icu:SigDemoWallet--copied')
                        : i18n('icu:SigDemoWallet--copy-invoice')}
                    </AxoButton.Root>
                  </>
                )}
              </div>
            )}
          </WalletSection>
          <WalletSection title={i18n('icu:SigDemoWallet--history')}>
            {transactions.length === 0 ? (
              <AxoTextItem.Root
                label={i18n('icu:SigDemoWallet--no-transactions')}
              />
            ) : (
              transactions.map(transaction => (
                <AxoTextItem.Root
                  key={transaction.id}
                  label={
                    transaction.inbound
                      ? i18n('icu:SigDemoWallet--received')
                      : i18n('icu:SigDemoWallet--sent')
                  }
                  value={formatAmount(transaction.amountMsat)}
                  description={dateFormatter.format(
                    transaction.settledAtMs ?? transaction.createdAtMs
                  )}
                  trailing={transactionStatusLabels[transaction.status]}
                />
              ))
            )}
          </WalletSection>
        </AxoList.Group>
      </AxoPanel.Content>
    </AxoPanel.Root>
  );
}
