// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

export type SigDemoInferenceProviderType =
  | 'mesh-llm'
  | 'mesh-llm-paid'
  | 'chatgpt';

export const SIG_DEMO_DEFAULT_INFERENCE_PROVIDER: SigDemoInferenceProviderType =
  'mesh-llm';

// The native Goose agent owns model context limits. These bound IPC input only.
export const SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES = 60;
export const SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES = 3 * 1024 * 1024;
export const SIG_DEMO_AGENT_INPUT_AUTHOR_MAX_BYTES = 4096;

export type SigDemoAgentHistoryMessageType = Readonly<{
  // Local bookkeeping only; the native agent excludes IDs from model prompts.
  id: string;
  role: 'user' | 'assistant';
  author: string;
  text: string;
}>;

export type SigDemoAgentRunRequestType = Readonly<{
  requestId: string;
  accountId: string;
  chatId: string;
  queryMessageId: string;
  responseMessageId: string;
  sourceText: string;
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
