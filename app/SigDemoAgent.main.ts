// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { z } from 'zod';

import {
  SIG_DEMO_AGENT_MODEL,
  SIG_DEMO_AGENT_HISTORY_MAX_MESSAGES,
  SIG_DEMO_AGENT_HISTORY_MAX_BYTES,
  SIG_DEMO_AGENT_HISTORY_MESSAGE_MAX_BYTES,
  SIG_DEMO_AGENT_AUTHOR_MAX_BYTES,
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
import { loadGdk } from '../sig-demo/gdk/bindings.node.ts';
import { createSigDemoAgentRuntime } from './SigDemoAgentRuntime.node.ts';
import { safeSigDemoAgentError } from './SigDemoAgentErrors.std.ts';

const log = createLogger('SigDemoAgent');

const authorSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    author => Buffer.byteLength(author) <= SIG_DEMO_AGENT_AUTHOR_MAX_BYTES
  );
const historySchema = z
  .array(
    z.object({
      role: z.enum(['user', 'assistant']),
      author: authorSchema,
      text: z
        .string()
        .trim()
        .min(1)
        .refine(
          text =>
            Buffer.byteLength(text) <= SIG_DEMO_AGENT_HISTORY_MESSAGE_MAX_BYTES
        ),
    })
  )
  .max(SIG_DEMO_AGENT_HISTORY_MAX_MESSAGES)
  .refine(
    history =>
      history.reduce(
        (total, message) =>
          total +
          Buffer.byteLength(message.author) +
          Buffer.byteLength(message.text),
        0
      ) <= SIG_DEMO_AGENT_HISTORY_MAX_BYTES
  );
const providerSchema = z.enum(['mesh-llm', 'mesh-llm-paid', 'chatgpt']);
const requestSchema = z.object({
  requestId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(65_536),
  provider: providerSchema,
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
    ? join(process.resourcesPath, 'sig-demo-gdk/libgoose_sdk.dylib')
    : join(
        getAppRootDir(),
        'sig-demo/gdk/native/target/release/libgoose_sdk.dylib'
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
      nativeRuntime = createSigDemoAgentRuntime(loadGdk(nativeLibrary()));
    }
    return nativeRuntime;
  };
  const starting = new Set<string>();
  const requestProviders = new Map<string, SigDemoInferenceProviderType>();
  const mesh = new SigDemoMesh();
  let selectedProvider = SIG_DEMO_DEFAULT_INFERENCE_PROVIDER;
  let selectionGeneration = 0;
  let nativeDrain: Promise<void> = Promise.resolve();
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
    });
  };
  const configureProvider = async (provider: SigDemoInferenceProviderType) => {
    const cancelled: Array<AgentTask> = [];
    if (selectedProvider !== provider) {
      selectedProvider = provider;
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
    await mesh.configure(provider);
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
    const provider = providerSchema.safeParse(value);
    if (!isMainSender(event) || !provider.success) {
      return { ok: false, error: 'This inference setting is unavailable.' };
    }
    try {
      await configureProvider(provider.data);
      return { ok: true };
    } catch {
      return {
        ok: false,
        error: 'The selected provider could not be prepared.',
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
    const { requestId, prompt, provider, author, history } = parsed.data;
    const requestedAt = performance.now();
    const send = (chunk: SigDemoAgentEventType) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('sig-demo-agent:event', chunk);
      }
    };
    let runtime: ReturnType<typeof loadRuntime>;
    let inference: Awaited<ReturnType<SigDemoMesh['getInference']>> | undefined;
    starting.add(requestId);
    requestProviders.set(requestId, provider);
    const generation = selectionGeneration;
    try {
      if (provider !== selectedProvider) {
        throw new Error('The inference provider changed.');
      }
      await nativeDrain;
      if (generation !== selectionGeneration || !starting.has(requestId)) {
        throw new Error('The inference provider changed.');
      }
      await mesh.configure(provider);
      if (
        generation !== selectionGeneration ||
        !starting.has(requestId) ||
        provider !== selectedProvider
      ) {
        throw new Error('The inference provider changed.');
      }
      runtime = loadRuntime(provider);
      if (!existsSync(nativeLibrary())) {
        starting.delete(requestId);
        requestProviders.delete(requestId);
        return {
          ok: false,
          error: 'The native Sig agent is missing from this build.',
        };
      }
      if (provider === 'mesh-llm') {
        inference = await prepareFreeInference();
      } else if (provider === 'mesh-llm-paid') {
        inference = await mesh.getInference(provider);
      }
    } catch {
      starting.delete(requestId);
      requestProviders.delete(requestId);
      let error = 'Sig is not configured in this build.';
      if (provider === 'mesh-llm-paid') {
        error =
          'Paid mesh inference is unavailable. Check Wallet and your connection, then try again.';
      } else if (provider === 'mesh-llm') {
        error =
          'No public mesh node is available. Try again, or choose ChatGPT under General → Inference.';
      }
      return {
        ok: false,
        error,
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
    const finish = (message?: string) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      log.info('Inference request finished', {
        provider,
        modelTurns,
        result: message ? 'error' : 'complete',
        totalMs: Math.round(performance.now() - requestedAt),
      });
      send(
        message
          ? { requestId, type: 'error', message }
          : { requestId, type: 'done' }
      );
    };
    const timeout = setTimeout(() => {
      controller.abort();
      finish('Sig took too long. Please try again.');
    }, 180_000);
    const execute = async () => {
      try {
        await getRuntime().runSigDemoAgent(
          {
            prompt,
            provider: provider === 'chatgpt' ? 'chatgpt' : 'mesh-llm',
            author,
            history,
            currentDate: new Date().toISOString().slice(0, 10),
            ...(inference ?? { model: runtime.model }),
          },
          { apiKey: runtime.apiKey, braveApiKey: runtime.braveApiKey },
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
            ? 'Sig stopped before completing its response.'
            : undefined
        );
      } catch (error) {
        // Native/provider diagnostics may contain prompts or credentials.
        finish(
          controller.signal.aborted
            ? 'Sig stopped before completing its response.'
            : safeSigDemoAgentError(error)
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
    mesh.stop();
  });
}
