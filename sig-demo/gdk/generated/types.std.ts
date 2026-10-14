// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Generated from the SDK cdylib UniFFI metadata. Run generate-types.node.mjs; do not edit.

export type CompactionMessage = Readonly<{ role: MessageRole; text: string }>;
export type CompactionSummary = Readonly<{
  text: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
}>;
export type CompactionTemplates = Readonly<{
  compaction: string;
  summary: string;
}>;
export type DecisionRequest = Readonly<{
  model: string;
  stateJson: string;
  questions: Readonly<Record<string, DecisionQuestion>>;
}>;
export type DecisionResponse = Readonly<{
  model: string;
  answers: Readonly<Record<string, DecisionAnswer>>;
  inputTokens?: number | bigint | null;
  outputTokens?: number | bigint | null;
  cost?: number | null;
  id?: string | null;
  provider?: string | null;
}>;
export type GooseStreamError = Readonly<{
  kind: GooseStreamErrorKind;
  message: string;
  retryAfterMs?: number | bigint | null;
  requestId?: string | null;
}>;
export type NoulCriteria = Readonly<{
  trueDescription: string;
  falseDescription: string;
}>;
export type ProviderCompletion = Readonly<{
  messageJson: string;
  content: ReadonlyArray<MessageContent>;
  usage?: Usage | null;
}>;
export type ProviderMessage = Readonly<{
  role: MessageRole;
  content: ReadonlyArray<MessageContent>;
}>;
export type ProviderModelConfig = Readonly<{
  modelName: string;
  contextLimit?: number | null;
  temperature?: number | null;
  maxTokens?: number | null;
  toolshim?: boolean;
  toolshimModel?: string | null;
  requestParamsJson?: string | null;
  providerParamsJson?: string | null;
  reasoning?: boolean | null;
  timeoutMs?: number | bigint | null;
  requestHeaders?: Readonly<Record<string, string>> | null;
}>;
export type ProviderModelInfo = Readonly<{
  name: string;
  contextLimit?: number | bigint | null;
  supportsReasoning: boolean;
}>;
export type ProviderTool = Readonly<{
  name: string;
  description: string;
  inputSchemaJson: string;
  annotationsJson?: string | null;
}>;
export type Usage = Readonly<{
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  reasoningTokens?: number | null;
  model: string;
  requestId?: string | null;
  providerMetadataJson?: string | null;
  additionalDataJson?: string | null;
}>;
export type RequestEndEvent = Readonly<{
  requestId: string;
  provider: string;
  model: string;
  operation: RequestOperation;
  outcome: RequestOutcome;
  durationMs: number | bigint;
  usage?: Usage | null;
  responseJson?: string | null;
}>;
export type RequestPayload = Readonly<{
  system: string;
  messagesJson: string;
  toolsJson: string;
}>;
export type RequestStartEvent = Readonly<{
  requestId: string;
  provider: string;
  model: string;
  operation: RequestOperation;
  payload?: RequestPayload | null;
}>;
export type ResponseStartEvent = Readonly<{
  requestId: string;
  provider: string;
  model: string;
  operation: RequestOperation;
  elapsedMs: number | bigint;
}>;
export type DecisionAnswer =
  | Readonly<{ kind: 'Noul'; noul: number }>
  | Readonly<{
      kind: 'Choice';
      choice: string;
      confidence: number;
      probabilities: Readonly<Record<string, number>>;
    }>
  | Readonly<{
      kind: 'Score';
      score: number;
      confidence: number;
      legendJson: Readonly<Record<string, string>>;
      probabilities: Readonly<Record<string, number>>;
    }>;
export type DecisionQuestion =
  | Readonly<{
      kind: 'Noul';
      instructions: string;
      criteria?: NoulCriteria | null;
    }>
  | Readonly<{
      kind: 'Choice';
      instructions: string;
      criteria: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      kind: 'Score';
      instructions: string;
      criteria: ReadonlyArray<string>;
    }>;
export type Feature =
  | 'Tools'
  | 'Streaming'
  | 'Images'
  | 'Documents'
  | 'JsonSchema'
  | 'Reasoning';
export type GooseErrorData =
  | Readonly<{
      kind: 'RateLimited';
      retryAfterMs?: number | bigint | null;
      retryAfterSuffix: string;
    }>
  | Readonly<{ kind: 'OutputTokenLimitExceeded'; details: string }>
  | Readonly<{ kind: 'ContextLengthExceeded'; details: string }>
  | Readonly<{ kind: 'Authentication'; details: string }>
  | Readonly<{ kind: 'Timeout'; details: string }>
  | Readonly<{ kind: 'ProviderUnavailable'; details: string }>
  | Readonly<{ kind: 'Generic'; details: string }>;
export type GooseStreamErrorKind =
  | 'RateLimited'
  | 'OutputTokenLimitExceeded'
  | 'ContextLengthExceeded'
  | 'Authentication'
  | 'Timeout'
  | 'ProviderUnavailable'
  | 'Generic';
export type MessageContent =
  | Readonly<{ kind: 'Text'; text: string }>
  | Readonly<{ kind: 'Image'; mimeType: string; data: Uint8Array<ArrayBuffer> }>
  | Readonly<{
      kind: 'Document';
      mimeType: string;
      data: Uint8Array<ArrayBuffer>;
      name?: string | null;
    }>
  | Readonly<{
      kind: 'ToolRequest';
      id: string;
      name: string;
      argumentsJson: string;
      providerMetadataJson?: string | null;
      toolErrorJson?: string | null;
    }>
  | Readonly<{
      kind: 'ToolResult';
      id: string;
      success: boolean;
      contentJson: string;
    }>
  | Readonly<{ kind: 'Thinking'; thinking: string; signature: string }>
  | Readonly<{ kind: 'RedactedThinking'; data: string }>;
export type MessageRole = 'User' | 'Assistant' | 'Tool';
export type StreamChunk =
  | Readonly<{ kind: 'TextChunk'; text: string }>
  | Readonly<{
      kind: 'ToolChunk';
      id: string;
      name: string;
      argumentsJson: string;
      index?: number | null;
      providerMetadataJson?: string | null;
    }>
  | Readonly<{ kind: 'ThinkingChunk'; thinking: string; signature: string }>
  | Readonly<{ kind: 'RedactedThinkingChunk'; data: string }>
  | Readonly<{ kind: 'EndChunk'; usage?: Usage | null }>
  | Readonly<{ kind: 'ErrorChunk'; error: GooseStreamError }>;
export type RequestOperation = 'Complete' | 'Stream';
export type RequestOutcome =
  | Readonly<{ kind: 'Success' }>
  | Readonly<{ kind: 'Failure'; error: GooseStreamError }>;
