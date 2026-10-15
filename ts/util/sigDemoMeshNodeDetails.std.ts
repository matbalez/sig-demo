// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { SigDemoMeshOptionType } from '../types/SigDemoMesh.std.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(normalized)
    ? normalized
    : undefined;
}

function latency(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 3_600_000
    ? Math.round(value)
    : undefined;
}

function hardware(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  for (const gpu of value.slice(0, 8)) {
    const fields = record(gpu);
    const name = text(fields?.name, 96);
    if (!name) continue;
    const capacity = fields?.rated_vram_gb;
    const memory =
      typeof capacity === 'number' &&
      Number.isFinite(capacity) &&
      capacity > 0 &&
      capacity <= 4096
        ? ` (${capacity} GB)`
        : '';
    names.add(`${name}${memory}`);
  }
  return text([...names].join(', '), 160);
}

function buildAttestation(
  value: unknown
): NonNullable<SigDemoMeshOptionType['releaseAttestation']> {
  const fields = record(value);
  if (fields?.verified === true && fields.status === 'valid') return 'verified';
  if (fields?.verified === false) return 'unverified';
  return 'unavailable';
}

/** Display metadata only: upstream release verification is not TEE attestation. */
export function enrichSigDemoMeshNodeDetails(
  options: ReadonlyArray<SigDemoMeshOptionType>,
  status: unknown
): Array<SigDemoMeshOptionType> {
  const peers = record(status)?.peers;
  if (!Array.isArray(peers)) return [...options];
  const nodeIds = [
    ...new Set(
      options
        .map(option => option.nodeId.toLowerCase())
        .filter(nodeId => /^[a-f0-9]{64}$/.test(nodeId))
    ),
  ];
  const details = new Map<string, Record<string, unknown>>();
  const duplicates = new Set<string>();
  for (const rawPeer of peers) {
    const peer = record(rawPeer);
    if (!peer || typeof peer.id !== 'string') continue;
    const id = peer.id.toLowerCase();
    if (!/^(?:[a-f0-9]{10}|[a-f0-9]{64})$/.test(id)) continue;
    const matches = nodeIds.filter(nodeId => nodeId.startsWith(id));
    if (matches.length !== 1) continue;
    const nodeId = matches[0];
    if (nodeId === undefined) continue;
    // Contradictory duplicate advertisements cannot identify a reliable detail.
    if (details.has(nodeId)) duplicates.add(nodeId);
    details.set(nodeId, peer);
  }
  return options.map(option => {
    const nodeId = option.nodeId.toLowerCase();
    const peer = details.get(nodeId);
    if (!peer || duplicates.has(nodeId)) return option;
    const hostname = text(peer.hostname, 128);
    const version = text(peer.version, 64);
    const latencyMs = latency(peer.latency_ms) ?? latency(peer.rtt_ms);
    const advertisedHardware = hardware(peer.gpus);
    return {
      ...option,
      ...(hostname === undefined ? {} : { hostname }),
      ...(version === undefined ? {} : { version }),
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(option.hardware !== undefined || advertisedHardware === undefined
        ? {}
        : { hardware: advertisedHardware }),
      releaseAttestation: buildAttestation(peer.release_attestation),
    };
  });
}
