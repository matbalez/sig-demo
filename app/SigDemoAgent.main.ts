// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { z } from 'zod';

import {
  SIG_DEMO_AGENT_MODEL,
  SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES,
  SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES,
  SIG_DEMO_AGENT_INPUT_AUTHOR_MAX_BYTES,
  SIG_DEMO_DEFAULT_INFERENCE_PROVIDER,
  type SigDemoAgentEventType,
  type SigDemoInferenceProviderType,
} from '../ts/types/SigDemoAgent.std.ts';
import { getAppRootDir } from '../ts/util/appRootDir.main.ts';
import {
  SigDemoMesh,
  type SigDemoMeshInferenceType,
} from './SigDemoMesh.main.ts';
import { drop } from '../ts/util/drop.std.ts';
import { createLogger } from '../ts/logging/log.std.ts';
import { loadSigAgent } from '../sig-demo/gdk/agent-bindings.node.ts';
import { createSigDemoAgentRuntime } from './SigDemoAgentRuntime.node.ts';
import {
  formatSigDemoAgentFailure,
  sigDemoAgentFailureDetails,
  sigDemoAgentSetupError,
  SigDemoAgentRuntimeError,
  type SigDemoAgentSetupPhaseType,
} from './SigDemoAgentErrors.std.ts';
import { parseSigDemoMeshOptionId } from '../ts/util/sigDemoMeshCatalog.std.ts';

const log = createLogger('SigDemoAgent');
const localIdSchema = z.string().min(1).max(256);

const authorSchema = z
  .string()
  .refine(
    author => Buffer.byteLength(author) <= SIG_DEMO_AGENT_INPUT_AUTHOR_MAX_BYTES
  );
const historySchema = z
  .array(
    z.object({
      id: localIdSchema,
      role: z.enum(['user', 'assistant']),
      author: authorSchema,
      text: z.string().min(1),
    })
  )
  .max(SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_MESSAGES)
  .refine(
    history =>
      history.reduce(
        (total, message) =>
          total +
          Buffer.byteLength(message.author) +
          Buffer.byteLength(message.text),
        0
      ) <= SIG_DEMO_AGENT_HISTORY_CANDIDATE_MAX_BYTES
  );
const providerSchema = z.enum(['mesh-llm', 'mesh-llm-paid', 'chatgpt']);
const meshSelectionSchema = z.string().max(4096);
const configurationSchema = z.union([
  providerSchema.transform(provider => ({ provider, selectionId: '' })),
  z.object({
    provider: providerSchema,
    selectionId: meshSelectionSchema.default(''),
  }),
]);
const requestSchema = z.object({
  requestId: z.string().uuid(),
  accountId: localIdSchema,
  chatId: localIdSchema,
  queryMessageId: localIdSchema,
  responseMessageId: localIdSchema,
  sourceText: z.string().min(1).max(131_072),
  prompt: z.string().trim().min(1).max(65_536),
  provider: providerSchema,
  meshSelectionId: meshSelectionSchema.optional(),
  author: authorSchema.optional(),
  history: historySchema.default([]),
});
const runtimeSchema = z.object({
  apiKey: z.string().min(20),
  model: z.string().min(1).default(SIG_DEMO_AGENT_MODEL),
});

const braveKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\u0021-\u007e]+$/);

function loadBraveKey(): string | undefined {
  if (app.isPackaged) {
    const runtime = JSON.parse(
      readFileSync(
        join(process.resourcesPath, 'sig-demo-gdk/runtime.json'),
        'utf8'
      )
    );
    return braveKeySchema.optional().parse(runtime.braveApiKey);
  }
  const path = join(getAppRootDir(), '.sig-demo/brave.env');
  if (!existsSync(path)) {
    return undefined;
  }
  const contents = readFileSync(path, 'utf8');
  const match = contents.match(
    /^\s*(?:export\s+)?BRAVE_SEARCH_API_KEY\s*=\s*([^\r\n]*)/m
  );
  return braveKeySchema.parse(
    match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
  );
}

function nativeLibrary(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'sig-demo-gdk/libsig_demo_agent.dylib')
    : join(
        getAppRootDir(),
        'sig-demo/gdk/native-agent/target/release/libsig_demo_agent.dylib'
      );
}

function loadRuntime(provider: SigDemoInferenceProviderType) {
  const root = getAppRootDir();
  const braveApiKey = provider !== 'chatgpt' ? loadBraveKey() : undefined;
  // Mesh uses no OpenAI credential, including when ChatGPT's file is absent.
  if (provider !== 'chatgpt') {
    return {
      model: SIG_DEMO_AGENT_MODEL,
      apiKey: undefined,
      braveApiKey,
    };
  }
  if (app.isPackaged) {
    const directory = join(process.resourcesPath, 'sig-demo-gdk');
    const runtime = runtimeSchema.parse(
      JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
    );
    return { ...runtime, braveApiKey };
  }
  // Keep the key outside NODE_CONFIG, whose values upstream logs at startup.
  const contents = readFileSync(join(root, '.sig-demo/agent.env'), 'utf8');
  const match = contents.match(
    /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*([^\r\n]*)/m
  );
  const apiKey = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  const runtime = runtimeSchema.parse({
    apiKey,
    model: process.env.SIG_DEMO_AGENT_MODEL ?? SIG_DEMO_AGENT_MODEL,
  });
  return {
    ...runtime,
    braveApiKey,
  };
}

type AgentTask = {
  controller: AbortController;
  done: Promise<void>;
};

/** The native GDK and credentials stay in Electron's main process. */
export function setupSigDemoAgent(
  getMainWebContents: () => WebContents | undefined
): void {
  const tasks = new Map<string, AgentTask>();
  const warmTasks = new Set<AgentTask>();
  let nativeRuntime: ReturnType<typeof createSigDemoAgentRuntime> | undefined;
  const getRuntime = () => {
    if (!nativeRuntime) {
      nativeRuntime = createSigDemoAgentRuntime(loadSigAgent(nativeLibrary()));
    }
    return nativeRuntime;
  };
  const starting = new Set<string>();
  const requestProviders = new Map<string, SigDemoInferenceProviderType>();
  const mesh = new SigDemoMesh();
  let selectedProvider = SIG_DEMO_DEFAULT_INFERENCE_PROVIDER;
  let selectedMeshSelectionId = '';
  let selectionGeneration = 0;
  let nativeDrain: Promise<void> = Promise.resolve();
  let activeAccountId: string | undefined;
  let sessionOwner: WebContents | undefined;
  const resetSessions = () => {
    selectionGeneration += 1;
    starting.clear();
    requestProviders.clear();
    const cancelled = [...tasks.values(), ...warmTasks];
    for (const task of cancelled) {
      task.controller.abort();
    }
    const previousDrain = nativeDrain;
    nativeDrain = (async () => {
      await Promise.allSettled([
        previousDrain,
        ...cancelled.map(task => task.done),
      ]);
      nativeRuntime?.disposeSessions();
    })();
  };
  const warmMeshInference = async (
    inference: SigDemoMeshInferenceType
  ): Promise<void> => {
    if (selectedProvider !== 'mesh-llm') {
      throw new Error('The inference provider changed.');
    }
    const startedAt = performance.now();
    const controller = new AbortController();
    const task: AgentTask = { controller, done: Promise.resolve() };
    // Free-only preparation contains synthetic input and no credentials.
    const timeout = setTimeout(() => controller.abort(), 20_000);
    warmTasks.add(task);
    task.done = (async () =>
      getRuntime().warmSigDemoMesh(inference, controller.signal, event => {
        log.info('Mesh warmup phase', {
          phase: event.phase,
          durationMs: event.durationMs,
          eventAtMs: Math.round(performance.now() - startedAt),
        });
      }))();
    let ready = false;
    try {
      await task.done;
      ready = true;
    } finally {
      clearTimeout(timeout);
      warmTasks.delete(task);
      log.info('Mesh inference warmup finished', {
        result: ready ? 'ready' : 'unavailable',
        totalMs: Math.round(performance.now() - startedAt),
      });
    }
  };
  const prepareFreeInference = () => {
    const generation = selectionGeneration;
    return mesh.prepareInference(route => {
      if (generation !== selectionGeneration) {
        throw new Error('The inference provider changed.');
      }
      return warmMeshInference(route);
    }, selectedMeshSelectionId);
  };
  const configureProvider = async (
    provider: SigDemoInferenceProviderType,
    selectionId = ''
  ) => {
    const meshSelectionId = provider === 'chatgpt' ? '' : selectionId;
    const cancelled: Array<AgentTask> = [];
    if (
      selectedProvider !== provider ||
      selectedMeshSelectionId !== meshSelectionId
    ) {
      selectedProvider = provider;
      selectedMeshSelectionId = meshSelectionId;
      selectionGeneration += 1;
      // A free warmup must never survive a switch to the paid mesh. Also stop
      // old mesh questions before changing their loopback destination/policy.
      cancelled.push(...warmTasks);
      for (const task of cancelled) {
        task.controller.abort();
      }
      for (const [requestId, requestProvider] of requestProviders) {
        if (requestProvider !== 'chatgpt') {
          starting.delete(requestId);
          const task = tasks.get(requestId);
          if (task) {
            task.controller.abort();
            cancelled.push(task);
          }
        }
      }
    }
    const generation = selectionGeneration;
    if (cancelled.length > 0) {
      const previousDrain = nativeDrain;
      nativeDrain = (async () => {
        await Promise.allSettled([
          previousDrain,
          ...cancelled.map(task => task.done),
        ]);
      })();
    }
    // Every caller, including duplicate configure IPC and new questions, shares
    // this barrier until the previous selection's native streams are disposed.
    // Drop streams and pending native futures before changing loopback routes.
    await nativeDrain;
    if (generation !== selectionGeneration) {
      throw new Error('The inference provider changed.');
    }
    await mesh.configure(provider, meshSelectionId);
    if (generation !== selectionGeneration) {
      throw new Error('The inference provider changed.');
    }
    if (provider === 'mesh-llm') {
      // The renderer supplies its saved preference as soon as storage is ready.
      // Paid mode connects without any speculative GDK completions.
      const prepare = async () => {
        try {
          await prepareFreeInference();
        } catch {
          // A foreground query reports unavailable inference if needed.
        }
      };
      drop(prepare());
    }
  };
  const isMainSender = (event: IpcMainInvokeEvent) =>
    event.sender === getMainWebContents() &&
    event.senderFrame === event.sender.mainFrame;
  ipcMain.handle('sig-demo-agent:configure', async (event, value: unknown) => {
    const configuration = configurationSchema.safeParse(value);
    if (!isMainSender(event) || !configuration.success) {
      return { ok: false, error: 'This inference setting is unavailable.' };
    }
    try {
      await configureProvider(
        configuration.data.provider,
        configuration.data.selectionId
      );
      return { ok: true };
    } catch (error) {
      const failure = sigDemoAgentSetupError(
        error,
        'provider-configuration',
        configuration.data.provider,
        Boolean(configuration.data.selectionId)
      );
      log.info(
        'Inference setup failed',
        sigDemoAgentFailureDetails(failure, {
          provider: configuration.data.provider,
          phase: 'provider-configuration',
        })
      );
      return {
        ok: false,
        error: failure.message,
      };
    }
  });
  ipcMain.handle('sig-demo-mesh:catalog', async (event, value: unknown) => {
    const request = z
      .object({ provider: z.enum(['mesh-llm', 'mesh-llm-paid']) })
      .safeParse(value);
    if (
      !isMainSender(event) ||
      !request.success ||
      request.data.provider !== selectedProvider
    ) {
      return { ok: false, error: 'Select a mesh provider before refreshing.' };
    }
    const generation = selectionGeneration;
    try {
      await nativeDrain;
      if (generation !== selectionGeneration) {
        throw new Error('The selected node changed.');
      }
      // Discovery may start/await this selected client, but never runs a GDK
      // warmup or inference. Paid catalog refreshes cannot spend wallet funds.
      await mesh.configure(request.data.provider, selectedMeshSelectionId);
      if (generation !== selectionGeneration) {
        throw new Error('The selected node changed.');
      }
      const catalog = await mesh.getInferenceOptions(request.data.provider);
      if (generation !== selectionGeneration) {
        throw new Error('The selected node changed.');
      }
      return { ok: true, value: catalog };
    } catch {
      return {
        ok: false,
        error: 'The mesh catalog is unavailable. Refresh to try again.',
      };
    }
  });
  ipcMain.handle('sig-demo-wallet:snapshot', async event => {
    if (!isMainSender(event)) {
      return { ok: false, error: 'The wallet is unavailable.' };
    }
    try {
      return { ok: true, value: await mesh.getWalletSnapshot() };
    } catch {
      return {
        ok: false,
        error:
          'The wallet could not be opened. Check your connection and refresh.',
      };
    }
  });
  ipcMain.handle('sig-demo-wallet:fund', async (event, amount: unknown) => {
    const parsed = z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000))
      .safeParse(amount);
    if (!isMainSender(event) || !parsed.success) {
      return { ok: false, error: 'Enter a positive whole-number amount.' };
    }
    try {
      return { ok: true, value: await mesh.fundWallet(parsed.data) };
    } catch {
      return {
        ok: false,
        error:
          'The invoice could not be confirmed. Refresh the wallet before trying again.',
      };
    }
  });
  ipcMain.handle('sig-demo-agent:start', async (event, value: unknown) => {
    const parsed = requestSchema.safeParse(value);
    if (
      !parsed.success ||
      event.sender !== getMainWebContents() ||
      event.senderFrame !== event.sender.mainFrame ||
      tasks.has(parsed.data.requestId) ||
      starting.has(parsed.data.requestId)
    ) {
      return { ok: false, error: 'Sig could not start this request.' };
    }
    const {
      requestId,
      accountId,
      chatId,
      queryMessageId,
      responseMessageId,
      sourceText,
      prompt,
      provider,
      meshSelectionId = '',
      author,
      history,
    } = parsed.data;
    if (sessionOwner !== event.sender) {
      sessionOwner = event.sender;
      event.sender.once('destroyed', () => {
        if (sessionOwner === event.sender) {
          sessionOwner = undefined;
          activeAccountId = undefined;
          resetSessions();
        }
      });
    }
    if (activeAccountId !== accountId) {
      if (activeAccountId !== undefined) {
        resetSessions();
      }
      activeAccountId = accountId;
    }
    const requestedAt = performance.now();
    // Independent of Signal's message, account, chat and encrypted frame IDs.
    const diagnosticId = randomUUID().slice(0, 8);
    const send = (chunk: SigDemoAgentEventType) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('sig-demo-agent:event', chunk);
      }
    };
    let runtime: ReturnType<typeof loadRuntime> | undefined;
    let inference: Awaited<ReturnType<SigDemoMesh['getInference']>> | undefined;
    let setupPhase: SigDemoAgentSetupPhaseType = 'provider-configuration';
    const selection = parseSigDemoMeshOptionId(meshSelectionId);
    const failureDetails = (error: unknown, phase: string) =>
      sigDemoAgentFailureDetails(error, {
        provider,
        phase,
        diagnosticId,
        model:
          provider === 'chatgpt'
            ? (runtime?.model ?? SIG_DEMO_AGENT_MODEL)
            : (inference?.model ?? selection?.model),
        nodeId: inference?.targetNodeId ?? selection?.nodeId,
      });
    starting.add(requestId);
    requestProviders.set(requestId, provider);
    const generation = selectionGeneration;
    try {
      if (
        provider !== selectedProvider ||
        (provider !== 'chatgpt' && meshSelectionId !== selectedMeshSelectionId)
      ) {
        throw new Error('The inference provider changed.');
      }
      await nativeDrain;
      if (generation !== selectionGeneration || !starting.has(requestId)) {
        throw new Error('The inference provider changed.');
      }
      await mesh.configure(provider, meshSelectionId);
      if (
        generation !== selectionGeneration ||
        !starting.has(requestId) ||
        provider !== selectedProvider
      ) {
        throw new Error('The inference provider changed.');
      }
      setupPhase = 'runtime-configuration';
      runtime = loadRuntime(provider);
      setupPhase = 'native-library';
      if (!existsSync(nativeLibrary())) {
        throw new Error('The native Sig agent is missing from this build.');
      }
      // Report loading/configuration failures before discovery's node fallback.
      getRuntime();
      setupPhase = 'inference-discovery';
      if (provider === 'mesh-llm') {
        inference = await prepareFreeInference();
      } else if (provider === 'mesh-llm-paid') {
        inference = await mesh.getInference(provider, meshSelectionId);
      }
    } catch (error) {
      starting.delete(requestId);
      requestProviders.delete(requestId);
      const failure = sigDemoAgentSetupError(
        error,
        setupPhase,
        provider,
        Boolean(meshSelectionId)
      );
      const details = failureDetails(failure, setupPhase);
      log.info('Inference setup failed', details);
      return {
        ok: false,
        error: formatSigDemoAgentFailure(failure, details),
      };
    }
    if (
      !starting.has(requestId) ||
      generation !== selectionGeneration ||
      event.sender.isDestroyed() ||
      event.sender !== getMainWebContents()
    ) {
      starting.delete(requestId);
      requestProviders.delete(requestId);
      return { ok: false, error: 'Sig stopped before starting this request.' };
    }
    starting.delete(requestId);
    const preparedAt = performance.now();
    log.info('Inference route ready', {
      provider,
      routeWaitMs: Math.round(preparedAt - requestedAt),
    });
    send({ requestId, type: 'status', status: 'responding' });
    const controller = new AbortController();
    const task: AgentTask = { controller, done: Promise.resolve() };
    tasks.set(requestId, task);
    let completed = false;
    let receivedText = false;
    let modelTurns = 0;
    let lastPhase = 'runtime-starting';
    const finish = (error?: unknown) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      const failed = error !== undefined;
      const details = failed ? failureDetails(error, lastPhase) : undefined;
      if (details) {
        log.info('Inference request failed', {
          ...details,
          modelTurns,
        });
      }
      log.info('Inference request finished', {
        provider,
        modelTurns,
        result: failed ? 'error' : 'complete',
        totalMs: Math.round(performance.now() - requestedAt),
      });
      send(
        details
          ? {
              requestId,
              type: 'error',
              message: formatSigDemoAgentFailure(error, details),
            }
          : { requestId, type: 'done' }
      );
    };
    const timeout = setTimeout(() => {
      controller.abort();
      finish(
        new SigDemoAgentRuntimeError(
          'Sig took too long. Please try again.',
          'timeout'
        )
      );
    }, 180_000);
    const execute = async () => {
      try {
        await getRuntime().runSigDemoAgent(
          {
            prompt,
            accountId,
            chatId,
            queryMessageId,
            responseMessageId,
            sourceText,
            provider: provider === 'chatgpt' ? 'chatgpt' : 'mesh-llm',
            author,
            history,
            currentDate: new Date().toISOString().slice(0, 10),
            ...(inference ?? { model: runtime?.model }),
          },
          { apiKey: runtime?.apiKey, braveApiKey: runtime?.braveApiKey },
          controller.signal,
          chunk => {
            if (completed) {
              return;
            }
            if (chunk.type === 'text') {
              if (!receivedText && chunk.text) {
                receivedText = true;
                log.info('Inference first text received', {
                  provider,
                  runtimeToFirstTextMs: Math.round(
                    performance.now() - preparedAt
                  ),
                });
              }
              send({ requestId, type: 'text', text: chunk.text });
            } else if (chunk.type === 'status') {
              send({ requestId, type: 'status', status: chunk.status });
            } else if (chunk.type === 'timing') {
              lastPhase = chunk.phase;
              if (chunk.phase === 'model-turn') {
                modelTurns += 1;
              }
              log.info('Inference phase', {
                provider,
                phase: chunk.phase,
                durationMs: chunk.durationMs,
                eventAtMs: Math.round(performance.now() - preparedAt),
                ...(chunk.phase === 'model-turn'
                  ? { modelTurn: modelTurns }
                  : {}),
              });
            }
          }
        );
        finish(
          controller.signal.aborted
            ? new SigDemoAgentRuntimeError(
                'Sig stopped before completing its response.'
              )
            : undefined
        );
      } catch (error) {
        finish(
          controller.signal.aborted
            ? new SigDemoAgentRuntimeError(
                'Sig stopped before completing its response.'
              )
            : (error ??
                new SigDemoAgentRuntimeError(
                  'Sig could not complete the request. Try again.'
                ))
        );
      } finally {
        // UI completion can precede teardown on a timeout. Keep the native job
        // tracked until all futures and streams are released.
        tasks.delete(requestId);
        requestProviders.delete(requestId);
      }
    };
    task.done = execute();
    drop(task.done);
    return { ok: true };
  });
  ipcMain.on('sig-demo-agent:cancel', (event, requestId: unknown) => {
    if (
      event.sender === getMainWebContents() &&
      event.senderFrame === event.sender.mainFrame &&
      typeof requestId === 'string'
    ) {
      starting.delete(requestId);
      tasks.get(requestId)?.controller.abort();
    }
  });
  app.on('before-quit', () => {
    starting.clear();
    requestProviders.clear();
    for (const task of tasks.values()) {
      task.controller.abort();
    }
    for (const task of warmTasks) {
      task.controller.abort();
    }
    nativeRuntime?.disposeSessions();
    mesh.stop();
  });
}
