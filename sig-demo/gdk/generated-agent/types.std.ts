// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Generated from the SDK cdylib UniFFI metadata. Run generate-types.node.mjs; do not edit.

export type SigAgentConfig = Readonly<{
  provider: SigAgentProvider;
  model: string;
  baseUrl?: string | null;
  targetNodeId?: string | null;
  apiKey?: string | null;
  braveApiKey?: string | null;
}>;
export type SigAgentRequest = Readonly<{
  mode: SigAgentMode;
  prompt: string;
  author?: string | null;
  history: ReadonlyArray<SigHistoryMessage>;
  currentDate?: string | null;
}>;
export type SigHistoryMessage = Readonly<{
  role: SigHistoryRole;
  author: string;
  text: string;
}>;
export type SigAgentErrorData = Readonly<{ kind: 'Generic'; details: string }>;
export type SigAgentEvent =
  | Readonly<{ kind: 'Text'; text: string }>
  | Readonly<{ kind: 'Status'; status: SigAgentStatus }>
  | Readonly<{ kind: 'Timing'; phase: string; durationMs: number | bigint }>
  | Readonly<{ kind: 'Done' }>
  | Readonly<{ kind: 'Error'; code: string; message: string }>;
export type SigAgentMode = 'Answer' | 'Warmup';
export type SigAgentProvider = 'MeshLlm' | 'Chatgpt';
export type SigAgentStatus = 'Responding' | 'Searching';
export type SigHistoryRole = 'User' | 'Assistant';
