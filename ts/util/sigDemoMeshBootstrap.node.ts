// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'node:buffer';
import { z } from 'zod';

export const SIG_DEMO_MESH_BOOTSTRAP_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;

const tokenSchema = z.string().min(1).max(32_768);
const endpointSchema = z.object({
  id: z.string().regex(/^[a-fA-F0-9]{64}$/),
  addrs: z.array(z.unknown()).min(1),
});
const cacheSchema = z.object({
  version: z.literal(1),
  savedAt: z.number().int().positive(),
  tokens: z.array(tokenSchema).min(2).max(4),
});
const advertisementSchema = z.object({
  listing: z.object({
    invite_token: tokenSchema,
    serving: z.array(z.string()),
    node_count: z.number().nonnegative(),
    client_count: z.number().nonnegative().default(0),
    max_clients: z.number().nonnegative().default(0),
    name: z.string().nullable().optional(),
    mesh_id: z.string().nullable().optional(),
  }),
  expires_at: z.number().nullable().optional(),
});

function publicBootstrapNodeId(token: string): string | undefined {
  try {
    const endpoint = endpointSchema.safeParse(
      JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    );
    return endpoint.success ? endpoint.data.id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** A single bootstrap bypasses upstream's concurrent client join path. */
export function parseSigDemoMeshBootstrapCache(
  value: unknown,
  now: number
): Array<string> | undefined {
  const parsed = cacheSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const age = now - parsed.data.savedAt;
  if (age < 0 || age > SIG_DEMO_MESH_BOOTSTRAP_CACHE_MAX_AGE) {
    return undefined;
  }
  const nodes = parsed.data.tokens.map(publicBootstrapNodeId);
  if (
    nodes.some(node => node === undefined) ||
    new Set(nodes).size !== nodes.length
  ) {
    return undefined;
  }
  return parsed.data.tokens;
}

/** Cache public community bootstraps, never this client's ephemeral invite. */
export function selectSigDemoMeshBootstrapTokens(
  discovered: unknown,
  options: Readonly<{
    now: number;
    preferredNodeIds?: ReadonlyArray<string>;
    meshId?: string;
  }>
): Array<string> {
  if (!Array.isArray(discovered)) {
    return [];
  }
  const preferred = new Set(
    options.preferredNodeIds?.map(node => node.toLowerCase())
  );
  const seen = new Set<string>();
  const candidates: Array<{ token: string; preferred: boolean }> = [];
  for (const value of discovered) {
    const parsed = advertisementSchema.safeParse(value);
    if (!parsed.success) {
      continue;
    }
    const { listing, expires_at: expiresAt } = parsed.data;
    if (
      (listing.name != null && listing.name.toLowerCase() !== 'mesh-llm') ||
      listing.serving.length === 0 ||
      listing.node_count === 0 ||
      (expiresAt != null && expiresAt * 1000 <= options.now) ||
      (listing.max_clients > 0 &&
        listing.client_count >= listing.max_clients) ||
      (options.meshId != null && listing.mesh_id !== options.meshId)
    ) {
      continue;
    }
    const nodeId = publicBootstrapNodeId(listing.invite_token);
    if (nodeId === undefined || seen.has(nodeId)) {
      continue;
    }
    seen.add(nodeId);
    candidates.push({
      token: listing.invite_token,
      preferred: preferred.has(nodeId),
    });
  }
  candidates.sort(
    (left, right) => Number(right.preferred) - Number(left.preferred)
  );
  return candidates.slice(0, 4).map(candidate => candidate.token);
}
