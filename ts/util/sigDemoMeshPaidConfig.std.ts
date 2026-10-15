// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

const nodeIdSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/)
  .toLowerCase();
const printable = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const fields = {
  inviteToken: z
    .string()
    .min(20)
    .max(16_384)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/),
  model: printable(128),
  expectedNodeId: nodeIdSchema,
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  label: printable(96).optional(),
  hosting: z.literal('phala').optional(),
  hardware: printable(160).optional(),
};
const nodeSchema = z.object(fields).strict();
const legacySchema = z
  .object({ ...fields, expectedNodeId: nodeIdSchema.optional() })
  .strict();
const collectionSchema = z
  .object({
    defaultNodeId: nodeIdSchema.optional(),
    nodes: z.array(nodeSchema).min(1).max(16),
  })
  .strict();

export type SigDemoPaidMeshNodeType = Readonly<{
  id: string;
  inviteToken: string;
  model: string;
  expectedNodeId?: string;
  label?: string;
  hosting?: 'phala';
  hardware?: string;
}>;
export type SigDemoPaidMeshConfigType = Readonly<{
  defaultNodeId?: string;
  nodes: ReadonlyArray<SigDemoPaidMeshNodeType>;
}>;

/** Private bootstrap configuration; return only explicit fields when packaging. */
export function parseSigDemoPaidMeshConfig(
  value: unknown
): SigDemoPaidMeshConfigType {
  const collection = collectionSchema.safeParse(value);
  const legacy = collection.success ? undefined : legacySchema.safeParse(value);
  let inputNodes: ReadonlyArray<z.output<typeof legacySchema>>;
  let defaultNodeId: string | undefined;
  if (collection.success) {
    inputNodes = collection.data.nodes;
    defaultNodeId = collection.data.defaultNodeId;
  } else if (legacy?.success) {
    inputNodes = [legacy.data];
  } else {
    // Schema diagnostics can contain invitation contents; expose a fixed error.
    throw new Error('The private paid mesh configuration is unusable.');
  }
  const nodes = inputNodes.map((node, index) => ({
    ...node,
    id: node.id ?? `paid-node-${index + 1}`,
  }));
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) {
    throw new Error('Paid mesh node identifiers must be unique.');
  }
  if (
    defaultNodeId !== undefined &&
    !nodes.some(node => node.expectedNodeId === defaultNodeId)
  ) {
    throw new Error(
      'The default paid node must match a configured node identity.'
    );
  }
  return {
    ...(defaultNodeId === undefined ? {} : { defaultNodeId }),
    nodes,
  };
}

/** Preserve the legacy wire shape when its single node has no identity pin. */
export function serializeSigDemoPaidMeshConfig(
  config: SigDemoPaidMeshConfigType
): string {
  const [singleNode] = config.nodes;
  const value =
    config.nodes.length === 1 && singleNode?.expectedNodeId === undefined
      ? singleNode
      : config;
  return JSON.stringify(value);
}
