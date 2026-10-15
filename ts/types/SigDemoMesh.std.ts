// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

export type SigDemoMeshProviderType = 'mesh-llm' | 'mesh-llm-paid';

/** Public discovery/configuration metadata. Invitations never cross this API. */
export type SigDemoMeshOptionType = Readonly<{
  id: string;
  model: string;
  nodeId: string;
  label?: string;
  paid: boolean;
  available: boolean;
  hosting?: 'phala';
  hardware?: string;
  hostname?: string;
  version?: string;
  latencyMs?: number;
  releaseAttestation?: 'verified' | 'unverified' | 'unavailable';
  contextWindowTokens?: number;
  capabilities?: ReadonlyArray<string>;
  lastSeenSecondsAgo?: number;
  inputMsatPerMillionTokens?: number;
  outputMsatPerMillionTokens?: number;
  minimumInvoiceMsat?: number;
}>;

export type SigDemoMeshCatalogType = Readonly<{
  options: ReadonlyArray<SigDemoMeshOptionType>;
  selectionId?: string;
  activeId?: string;
}>;

export type SigDemoMeshCatalogResultType =
  | Readonly<{ ok: true; value: SigDemoMeshCatalogType }>
  | Readonly<{ ok: false; error: string }>;
