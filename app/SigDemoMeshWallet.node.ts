// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

import type {
  SigDemoWalletInvoiceType,
  SigDemoWalletSnapshotType,
} from '../ts/types/SigDemoWallet.std.ts';

const runFile = promisify(execFile);
const amountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const balanceSchema = z.object({
  spendable_msat: amountSchema,
  available_for_inference_msat: amountSchema,
});
const transactionsSchema = z.array(
  z.object({
    id: z.string().min(1).max(1024),
    payment_hash: z.string().max(128).nullable().optional(),
    inbound: z.boolean(),
    amount_msat: amountSchema,
    fee_msat: amountSchema,
    status: z.enum(['pending', 'succeeded', 'failed']),
    created_at_ms: amountSchema,
    settled_at_ms: amountSchema.nullable().optional(),
  })
);
const policySchema = z.object({
  mode: z.enum(['automatic', 'free_only']),
  daily_budget_msat: amountSchema.nullable().optional(),
  spent_today_msat: amountSchema,
  remaining_daily_budget_msat: amountSchema.nullable().optional(),
});
const invoiceSchema = z.object({
  bolt11: z
    .string()
    .min(1)
    .max(16_384)
    .regex(/^lnbc[0-9a-z]+$/i),
  payment_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  amount_msat: amountSchema.positive(),
  expires_at_ms: amountSchema.positive(),
});

export const SIG_DEMO_MESH_DAILY_BUDGET_MSAT = 500_000;

/** Operator-only access to the wallet owned by this application's mesh child. */
export class SigDemoMeshWallet {
  #installPromise: Promise<boolean> | undefined;
  #installed = false;
  readonly binary: string;
  readonly directory: string;
  readonly consolePort: number;
  readonly environment: () => NodeJS.ProcessEnv;

  constructor(
    binary: string,
    directory: string,
    consolePort: number,
    environment: () => NodeJS.ProcessEnv
  ) {
    this.binary = binary;
    this.directory = directory;
    this.consolePort = consolePort;
    this.environment = environment;
  }

  async ensureInstalled(): Promise<boolean> {
    if (this.#installed) {
      return true;
    }
    if (!this.#installPromise) {
      this.#installPromise = this.#install();
    }
    const installation = this.#installPromise;
    try {
      this.#installed = await installation;
      return this.#installed;
    } finally {
      if (this.#installPromise === installation) {
        this.#installPromise = undefined;
      }
    }
  }

  async #install(): Promise<boolean> {
    try {
      const metadataPath = join(
        this.directory,
        'plugins/lexe-wallet/plugin-install.json'
      );
      let installed: { enabled: boolean; install_path: string } | undefined;
      try {
        installed = z
          .object({
            name: z.literal('lexe-wallet'),
            enabled: z.boolean(),
            install_path: z.string().min(1),
          })
          .parse(JSON.parse(await readFile(metadataPath, 'utf8')));
      } catch {
        // Fresh installs and incomplete downloads use the normal installer.
      }
      if (
        !installed ||
        !existsSync(join(installed.install_path, 'lexe-wallet'))
      ) {
        await this.#command(
          ['plugins', 'install', 'Mesh-LLM/lexe-wallet@v0.1.0'],
          120_000
        );
      } else if (!installed.enabled) {
        await this.#command(['plugins', 'enable', 'lexe-wallet']);
      }
      // Installation is retried on the next wallet/paid operation after failure.
      return true;
    } catch {
      return false;
    }
  }

  async #command(args: Array<string>, timeout = 15_000): Promise<void> {
    await runFile(this.binary, args, {
      cwd: this.directory,
      env: this.environment(),
      timeout,
      maxBuffer: 1024 * 1024,
    });
  }

  async #request(pid: number, command: object): Promise<unknown> {
    const response = await fetch(
      `http://127.0.0.1:${this.consolePort}/api/wallet`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          ...command,
          expected_pid: pid,
          expected_directory: join(this.directory, 'payments'),
        }),
      }
    );
    if (!response.ok) {
      throw new Error('The local wallet is unavailable. Please try again.');
    }
    return response.json();
  }

  async setPolicy(pid: number | undefined, paid: boolean): Promise<void> {
    if (pid == null) {
      // With the child stopped, this updates only the durable payment ledger.
      // It does not open or provision a Lexe wallet.
      await this.#command([
        '--config',
        join(this.directory, 'config.toml'),
        'wallet',
        '--port',
        String(this.consolePort),
        'policy',
        '--mode',
        paid ? 'automatic' : 'free-only',
        ...(paid ? ['--daily-budget-sats', '500'] : []),
      ]);
      return;
    }
    policySchema.parse(
      await this.#request(pid, {
        command: 'policy',
        value: {
          mode: paid ? 'automatic' : 'free_only',
          daily_budget_msat: paid ? SIG_DEMO_MESH_DAILY_BUDGET_MSAT : null,
        },
      })
    );
  }

  async snapshot(pid: number): Promise<SigDemoWalletSnapshotType> {
    const results = await Promise.all([
      this.#request(pid, { command: 'balance' }),
      this.#request(pid, { command: 'transactions', limit: 50 }),
      this.#request(pid, { command: 'policy', value: null }),
    ]);
    const balance = balanceSchema.parse(results[0]);
    const transactions = transactionsSchema.parse(results[1]);
    const policy = policySchema.parse(results[2]);
    return {
      spendableMsat: balance.spendable_msat,
      availableForInferenceMsat: balance.available_for_inference_msat,
      transactions: transactions.map(transaction => ({
        id: transaction.id,
        paymentHash: transaction.payment_hash ?? undefined,
        inbound: transaction.inbound,
        amountMsat: transaction.amount_msat,
        feeMsat: transaction.fee_msat,
        status: transaction.status,
        createdAtMs: transaction.created_at_ms,
        settledAtMs: transaction.settled_at_ms ?? undefined,
      })),
      policy: {
        mode: policy.mode,
        dailyBudgetMsat: policy.daily_budget_msat ?? undefined,
        spentTodayMsat: policy.spent_today_msat,
        remainingDailyBudgetMsat:
          policy.remaining_daily_budget_msat ?? undefined,
      },
    };
  }

  async fund(
    pid: number,
    amountSats: number
  ): Promise<SigDemoWalletInvoiceType> {
    if (
      !Number.isSafeInteger(amountSats) ||
      amountSats <= 0 ||
      amountSats > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    ) {
      throw new Error('Enter a positive whole amount to fund the wallet.');
    }
    // Never retry invoice creation automatically after an uncertain response.
    const invoice = invoiceSchema.parse(
      await this.#request(pid, {
        command: 'fund',
        amount_msat: amountSats * 1000,
      })
    );
    if (invoice.amount_msat !== amountSats * 1000) {
      throw new Error('The wallet returned an unexpected invoice amount.');
    }
    return {
      bolt11: invoice.bolt11,
      paymentHash: invoice.payment_hash,
      amountMsat: invoice.amount_msat,
      expiresAtMs: invoice.expires_at_ms,
    };
  }
}
