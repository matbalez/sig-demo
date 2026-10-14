// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useSelector } from 'react-redux';
import { getIntl } from '../selectors/user.std.ts';
import {
  PreferencesSigDemoWallet,
  type SigDemoWalletInvoiceStatusType,
} from '../../components/PreferencesSigDemoWallet.dom.tsx';
import {
  fundSigDemoWallet,
  getSigDemoWalletSnapshot,
} from '../../services/sigDemoWalletClient.preload.ts';
import type {
  SigDemoWalletInvoiceType,
  SigDemoWalletSnapshotType,
} from '../../types/SigDemoWallet.std.ts';
import { drop } from '../../util/drop.std.ts';

const POLL_INTERVAL_MS = 5000;

export function SmartPreferencesSigDemoWallet(): JSX.Element {
  const i18n = useSelector(getIntl);
  const [snapshot, setSnapshot] = useState<SigDemoWalletSnapshotType>();
  const [invoice, setInvoice] = useState<SigDemoWalletInvoiceType>();
  const [isLoading, setIsLoading] = useState(true);
  const [isFunding, setIsFunding] = useState(false);
  const [error, setError] = useState<'snapshot' | 'fund' | 'copy'>();
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const refreshing = useRef(false);
  const funding = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing.current) {
      return;
    }
    refreshing.current = true;
    try {
      const updated = await getSigDemoWalletSnapshot();
      if (mounted.current) {
        setSnapshot(updated);
        setError(previous => (previous === 'snapshot' ? undefined : previous));
      }
    } catch {
      if (mounted.current) {
        setError(previous => previous ?? 'snapshot');
      }
    }
    refreshing.current = false;
    if (mounted.current) {
      setIsLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (mounted.current) {
        drop(refresh());
      }
    });
    const interval = setInterval(() => {
      setNow(Date.now());
      drop(refresh());
    }, POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  const fund = useCallback(
    async (amountSats: number): Promise<void> => {
      if (funding.current) {
        return;
      }
      funding.current = true;
      setIsFunding(true);
      setError(undefined);
      try {
        const created = await fundSigDemoWallet(amountSats);
        if (mounted.current) {
          setInvoice(created);
          setCopied(false);
          setNow(Date.now());
          drop(refresh());
        }
      } catch {
        if (mounted.current) {
          setError('fund');
        }
      }
      funding.current = false;
      if (mounted.current) {
        setIsFunding(false);
      }
    },
    [refresh]
  );

  const copyInvoice = useCallback(async (): Promise<void> => {
    if (!invoice) {
      return;
    }
    try {
      await navigator.clipboard.writeText(invoice.bolt11);
      if (mounted.current) {
        setCopied(true);
        setError(previous => (previous === 'copy' ? undefined : previous));
      }
    } catch {
      if (mounted.current) {
        setError('copy');
      }
    }
  }, [invoice]);

  let invoiceStatus: SigDemoWalletInvoiceStatusType = 'pending';
  if (invoice) {
    const payment = snapshot?.transactions.find(
      transaction =>
        transaction.inbound &&
        transaction.paymentHash?.toLowerCase() ===
          invoice.paymentHash.toLowerCase()
    );
    if (payment?.status === 'succeeded') {
      invoiceStatus = 'paid';
    } else if (payment?.status === 'failed') {
      invoiceStatus = 'failed';
    } else if (now >= invoice.expiresAtMs) {
      invoiceStatus = 'expired';
    }
  }

  return (
    <PreferencesSigDemoWallet
      i18n={i18n}
      snapshot={snapshot}
      invoice={invoice}
      invoiceStatus={invoiceStatus}
      isLoading={isLoading}
      isFunding={isFunding}
      error={error}
      copied={copied}
      onRefresh={() => {
        if (!refreshing.current) {
          setIsLoading(true);
          drop(refresh());
        }
      }}
      onFund={amountSats => drop(fund(amountSats))}
      onCopyInvoice={() => drop(copyInvoice())}
    />
  );
}
