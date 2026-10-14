// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

export type SigDemoInferenceProviderType = 'mesh-llm' | 'chatgpt';

export const SIG_DEMO_DEFAULT_INFERENCE_PROVIDER: SigDemoInferenceProviderType =
  'mesh-llm';

export type SigDemoAgentRunRequestType = Readonly<{
  requestId: string;
  prompt: string;
  provider: SigDemoInferenceProviderType;
}>;

export type SigDemoAgentEventType =
  | Readonly<{ requestId: string; type: 'text'; text: string }>
  | Readonly<{ requestId: string; type: 'done' }>
  | Readonly<{ requestId: string; type: 'error'; message: string }>;

export const SIG_DEMO_AGENT_MODEL = 'gpt-6-luna';
