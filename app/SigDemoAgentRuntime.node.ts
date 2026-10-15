// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Signal passes chat records to the native Goose agent and renders its events.
// Prompts, context selection, tools and inference continuation all live in Rust.
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type {
  SigAgentBindings,
  SigAgentConfig,
  SigAgentRequest,
  SigAgentStream,
} from '../sig-demo/gdk/agent-bindings.node.ts';
import {
  SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES,
  SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES,
  SIG_DEMO_AGENT_INPUT_AUTHOR_MAX_BYTES,
  SIG_DEMO_AGENT_MODEL,
  type SigDemoAgentHistoryMessageType,
} from '../ts/types/SigDemoAgent.std.ts';
import {
  safeSigDemoAgentError,
  sigDemoAgentErrorCode,
  SigDemoAgentRuntimeError,
} from './SigDemoAgentErrors.std.ts';

export type SigDemoAgentRuntimeRequestType = Readonly<{
  mode?: 'answer' | 'warmup';
  prompt?: string;
  provider?: 'mesh-llm' | 'chatgpt';
  accountId?: string;
  chatId?: string;
  queryMessageId?: string;
  responseMessageId?: string;
  sourceText?: string;
  author?: string;
  history?: ReadonlyArray<SigDemoAgentHistoryMessageType>;
  currentDate?: string;
  model?: string;
  baseUrl?: string;
  targetNodeId?: string;
}>;
export type SigDemoAgentCredentialsType = Readonly<{
  apiKey?: string;
  braveApiKey?: string;
}>;
export type SigDemoMeshRouteType = Readonly<{
  baseUrl: string;
  model: string;
  targetNodeId: string;
}>;
export type SigDemoAgentTimingEventType = Readonly<{
  type: 'timing';
  phase:
    | 'runtime-started'
    | 'model-turn'
    | 'search'
    | 'answer-first-text'
    | 'answer'
    | 'warmup';
  durationMs: number;
}>;
export type SigDemoAgentRuntimeEventType =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'status'; status: 'searching' | 'responding' }>
  | SigDemoAgentTimingEventType
  | Readonly<{ type: 'done' }>;

type Output = (event: SigDemoAgentRuntimeEventType) => void;
const localIdSchema = z.string().min(1).max(256);
const requestSchema = z
  .object({
    mode: z.enum(['answer', 'warmup']).default('answer'),
    prompt: z.string().default(''),
    provider: z.enum(['mesh-llm', 'chatgpt']).default('chatgpt'),
    accountId: localIdSchema.optional(),
    chatId: localIdSchema.optional(),
    queryMessageId: localIdSchema.optional(),
    responseMessageId: localIdSchema.optional(),
    sourceText: z.string().max(131_072).default(''),
    author: z
      .string()
      .refine(
        value =>
          Buffer.byteLength(value) <= SIG_DEMO_AGENT_INPUT_AUTHOR_MAX_BYTES
      )
      .optional(),
    history: z
      .array(
        z
          .object({
            id: localIdSchema,
            role: z.enum(['user', 'assistant']),
            author: z.string(),
            text: z.string(),
          })
          .strict()
      )
      .max(SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES)
      .refine(
        messages =>
          messages.reduce(
            (bytes, message) =>
              bytes +
              Buffer.byteLength(message.author) +
              Buffer.byteLength(message.text),
            0
          ) <= SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES
      )
      .default([]),
    currentDate: z.string().optional(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    targetNodeId: z.string().optional(),
  })
  .strict();
const timingPhaseSchema = z.enum([
  'runtime-started',
  'model-turn',
  'search',
  'answer-first-text',
  'answer',
  'warmup',
]);

export function createSigDemoAgentRuntime(agents: SigAgentBindings): Readonly<{
  disposeSessions: () => void;
  runSigDemoAgent: (
    request: SigDemoAgentRuntimeRequestType,
    credentials: SigDemoAgentCredentialsType,
    signal: AbortSignal,
    onEvent: Output
  ) => Promise<void>;
  warmSigDemoMesh: (
    route: SigDemoMeshRouteType,
    signal: AbortSignal,
    onTiming: (event: SigDemoAgentTimingEventType) => void
  ) => Promise<void>;
}> {
  // A native session owns Goose's conversation. This map owns only its handle.
  // Keys are local bookkeeping and never become part of a model prompt.
  const sessions = new Map<
    string,
    ReturnType<SigAgentBindings['createSession']>
  >();
  const disposeSessions = () => {
    for (const session of sessions.values()) {
      session.dispose();
    }
    sessions.clear();
  };
  const runSigDemoAgent = async (
    input: SigDemoAgentRuntimeRequestType,
    credentials: SigDemoAgentCredentialsType,
    externalSignal: AbortSignal,
    output: Output
  ): Promise<void> => {
    const parsed = requestSchema.safeParse(input);
    if (
      !parsed.success ||
      Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024
    ) {
      throw new SigDemoAgentRuntimeError('Invalid agent request.');
    }
    const request = parsed.data;
    if (
      request.mode === 'answer' &&
      (!request.accountId ||
        !request.chatId ||
        !request.queryMessageId ||
        !request.responseMessageId ||
        !request.sourceText)
    ) {
      throw new SigDemoAgentRuntimeError('Invalid agent session request.');
    }
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(),
      request.mode === 'warmup' ? 15_000 : 120_000
    );
    const signal = AbortSignal.any([externalSignal, deadline.signal]);
    try {
      signal.throwIfAborted();
      const mesh = request.provider === 'mesh-llm';
      const config: SigAgentConfig = {
        provider: mesh ? 'MeshLlm' : 'Chatgpt',
        model: request.model ?? SIG_DEMO_AGENT_MODEL,
        baseUrl: request.baseUrl,
        targetNodeId: request.targetNodeId,
        apiKey: mesh ? undefined : credentials.apiKey,
        braveApiKey: mesh ? credentials.braveApiKey : undefined,
      };
      const nativeRequest: SigAgentRequest = {
        mode: request.mode === 'warmup' ? 'Warmup' : 'Answer',
        queryId: request.queryMessageId ?? '',
        responseId: request.responseMessageId ?? '',
        sourceText: request.sourceText,
        prompt: request.prompt,
        author: request.author,
        history: request.history.map(message => ({
          id: message.id,
          role: message.role === 'assistant' ? 'Assistant' : 'User',
          author: message.author,
          text: message.text,
        })),
        currentDate: request.currentDate,
      };
      let stream: SigAgentStream;
      if (request.mode === 'warmup') {
        stream = await agents.start(config, nativeRequest, signal);
      } else {
        // The validated answer envelope always supplies this account/chat pair.
        const accountId = localIdSchema.parse(request.accountId);
        const chatId = localIdSchema.parse(request.chatId);
        const key = JSON.stringify([accountId, chatId]);
        let session = sessions.get(key);
        if (!session) {
          session = agents.createSession(accountId, chatId);
          sessions.set(key, session);
        }
        stream = await session.run(config, nativeRequest, signal);
      }
      const cancel = () => stream.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        let complete = false;
        while (!complete) {
          signal.throwIfAborted();
          // Consume native agent events in order; Rust owns all tool/model turns.
          // oxlint-disable-next-line no-await-in-loop
          const event = await stream.nextEvent(signal);
          signal.throwIfAborted();
          if (!event) {
            throw new SigDemoAgentRuntimeError(
              'Sig stopped before completing its response.'
            );
          }
          switch (event.kind) {
            case 'Text':
              output({ type: 'text', text: event.text });
              break;
            case 'Status':
              output({
                type: 'status',
                status:
                  event.status === 'Searching' ? 'searching' : 'responding',
              });
              break;
            case 'Timing': {
              const phase = timingPhaseSchema.parse(event.phase);
              output({
                type: 'timing',
                phase,
                durationMs: Number(event.durationMs),
              });
              break;
            }
            case 'Error':
              throw new SigDemoAgentRuntimeError(event.message, event.code, {
                httpStatus: event.httpStatus,
                reasonCode: event.reasonCode,
              });
            case 'Done':
              complete = true;
              break;
            default:
              throw new SigDemoAgentRuntimeError(
                'Sig returned an unsupported response.'
              );
          }
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        try {
          await stream.shutdown();
        } finally {
          stream.dispose();
        }
      }
      signal.throwIfAborted();
      // Publish completion after native workers have finished and released I/O.
      output({ type: 'done' });
    } catch (error) {
      if (signal.aborted) {
        throw new SigDemoAgentRuntimeError(
          externalSignal.aborted
            ? "Sig's request was cancelled."
            : "Sig's request timed out. Try again.",
          externalSignal.aborted ? 'application-error' : 'timeout'
        );
      }
      if (error instanceof SigDemoAgentRuntimeError) throw error;
      throw new SigDemoAgentRuntimeError(
        safeSigDemoAgentError(error),
        sigDemoAgentErrorCode(error)
      );
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    disposeSessions,
    runSigDemoAgent,
    warmSigDemoMesh: (route, signal, onTiming) =>
      runSigDemoAgent(
        { mode: 'warmup', provider: 'mesh-llm', ...route },
        {},
        signal,
        event => {
          if (event.type === 'timing') onTiming(event);
        }
      ),
  };
}
