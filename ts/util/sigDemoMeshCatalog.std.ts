// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { SigDemoMeshOptionType } from '../types/SigDemoMesh.std.ts';

const modelSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    value =>
      value !== 'mesh' &&
      value !== 'auto' &&
      !/[\u0000-\u001f\u007f]/.test(value)
  );
const nodeSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/)
  .toLowerCase();
const amountSchema = z.number().finite().nonnegative().optional();
const catalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(1024),
      owned_by: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      metadata: z
        .object({ context_length: z.number().positive().int().optional() })
        .optional(),
      payment: z
        .object({
          offers: z.array(
            z.object({
              provider_id: z.string(),
              paid: z.boolean(),
              local: z.boolean(),
              peer_last_seen_seconds_ago: amountSchema,
              pricing: z
                .object({
                  input_msat_per_million: amountSchema,
                  output_msat_per_million: amountSchema,
                  minimum_invoice_msat: amountSchema,
                })
                .nullable()
                .optional(),
            })
          ),
        })
        .optional(),
    })
  ),
});

export function getSigDemoMeshOptionId(model: string, nodeId: string): string {
  return JSON.stringify([model, nodeId.toLowerCase()]);
}

export function parseSigDemoMeshOptionId(
  value: string
): Readonly<{ model: string; nodeId: string }> | undefined {
  if (value.length > 1024) return undefined;
  try {
    const parsed = z
      .tuple([modelSchema, nodeSchema])
      .safeParse(JSON.parse(value));
    return parsed.success
      ? { model: parsed.data[0], nodeId: parsed.data[1] }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Advertisements describe routing and prices; they never authorize spending. */
export function parseSigDemoMeshCatalog(
  value: unknown,
  paid: boolean
): Array<SigDemoMeshOptionType> {
  const catalog = catalogSchema.parse(value);
  const options = new Map<string, SigDemoMeshOptionType>();
  for (const model of catalog.data) {
    if (
      !modelSchema.safeParse(model.id).success ||
      model.owned_by?.startsWith('plugin:') ||
      !model.capabilities?.includes('text')
    )
      continue;
    for (const offer of model.payment?.offers ?? []) {
      const node = nodeSchema.safeParse(offer.provider_id);
      if (!node.success || offer.paid !== paid || offer.local) continue;
      const id = getSigDemoMeshOptionId(model.id, node.data);
      options.set(id, {
        id,
        model: model.id,
        nodeId: node.data,
        paid,
        available: true,
        capabilities: model.capabilities
          .filter(capability => capability.length <= 40)
          .slice(0, 16),
        contextWindowTokens: model.metadata?.context_length,
        lastSeenSecondsAgo: offer.peer_last_seen_seconds_ago,
        inputMsatPerMillionTokens: offer.pricing?.input_msat_per_million,
        outputMsatPerMillionTokens: offer.pricing?.output_msat_per_million,
        minimumInvoiceMsat: offer.pricing?.minimum_invoice_msat,
      });
    }
  }
  return [...options.values()].sort(
    (left, right) =>
      left.model.localeCompare(right.model) ||
      left.nodeId.localeCompare(right.nodeId)
  );
}
