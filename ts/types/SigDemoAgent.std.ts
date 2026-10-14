// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

export type SigDemoInferenceProviderType = 'mesh-llm' | 'chatgpt';

export const SIG_DEMO_DEFAULT_INFERENCE_PROVIDER: SigDemoInferenceProviderType =
  'mesh-llm';

export const SIG_DEMO_AGENT_HISTORY_MAX_MESSAGES = 12;
export const SIG_DEMO_AGENT_HISTORY_MAX_BYTES = 6000;
export const SIG_DEMO_AGENT_HISTORY_MESSAGE_MAX_BYTES = 1500;
export const SIG_DEMO_AGENT_AUTHOR_MAX_BYTES = 96;

export type SigDemoAgentHistoryMessageType = Readonly<{
  role: 'user' | 'assistant';
  author: string;
  text: string;
}>;

export type SigDemoAgentRunRequestType = Readonly<{
  requestId: string;
  prompt: string;
  provider: SigDemoInferenceProviderType;
  author?: string;
  history?: ReadonlyArray<SigDemoAgentHistoryMessageType>;
}>;

export type SigDemoAgentStatusType = 'responding' | 'searching';

export type SigDemoAgentEventType =
  | Readonly<{ requestId: string; type: 'text'; text: string }>
  | Readonly<{
      requestId: string;
      type: 'status';
      status: SigDemoAgentStatusType;
    }>
  | Readonly<{ requestId: string; type: 'done' }>
  | Readonly<{ requestId: string; type: 'error'; message: string }>;

export const SIG_DEMO_AGENT_MODEL = 'gpt-6-luna';
