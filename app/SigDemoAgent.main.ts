// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
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
const chunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('status'),
    status: z.enum(['searching', 'responding']),
  }),
  z.object({
    type: z.literal('timing'),
    phase: z.enum([
      'helper-started',
      'model-turn',
      'native-planning',
      'json-planning',
      'search',
      'answer-first-text',
      'answer',
      'warmup',
    ]),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
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
        join(process.resourcesPath, 'sig-demo-agent/runtime.json'),
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

function agentBinary(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'sig-demo-agent/sig-demo-agent')
    : join(getAppRootDir(), 'sig-demo/agent/target/release/sig-demo-agent');
}

function loadRuntime(provider: SigDemoInferenceProviderType) {
  const root = getAppRootDir();
  const binary = agentBinary();
  const braveApiKey = provider !== 'chatgpt' ? loadBraveKey() : undefined;
  // Mesh uses no OpenAI credential, including when ChatGPT's file is absent.
  if (provider !== 'chatgpt') {
    return {
      binary,
      model: SIG_DEMO_AGENT_MODEL,
      apiKey: undefined,
      braveApiKey,
    };
  }
  if (app.isPackaged) {
    const directory = join(process.resourcesPath, 'sig-demo-agent');
    const runtime = runtimeSchema.parse(
      JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
    );
    return { ...runtime, binary, braveApiKey };
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
    binary,
    braveApiKey,
  };
}

/** The credential stays in the main process and its local GDK child only. */
export function setupSigDemoAgent(
  getMainWebContents: () => WebContents | undefined
): void {
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  const warmChildren = new Set<ChildProcessWithoutNullStreams>();
  const starting = new Set<string>();
  const requestProviders = new Map<string, SigDemoInferenceProviderType>();
  const mesh = new SigDemoMesh();
  let selectedProvider = SIG_DEMO_DEFAULT_INFERENCE_PROVIDER;
  let selectionGeneration = 0;
  const warmMeshInference = async (
    inference: SigDemoMeshInferenceType
  ): Promise<void> => {
    if (selectedProvider !== 'mesh-llm') {
      throw new Error('The inference provider changed.');
    }
    const binary = agentBinary();
    if (!existsSync(binary)) {
      throw new Error('The local Sig agent is missing from this build.');
    }
    await new Promise<void>((resolve, reject) => {
      // Warm only the free selected mesh route, with synthetic input and no
      // credentials or conversation data. OpenAI is never warmed at startup.
      const env: NodeJS.ProcessEnv = {};
      for (const name of [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'TMPDIR',
        'LANG',
      ]) {
        env[name] = process.env[name];
      }
      const startedAt = performance.now();
      const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      warmChildren.add(child);
      let finished = false;
      const finish = (ok: boolean) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeout);
        warmChildren.delete(child);
        child.kill();
        log.info('Mesh inference warmup finished', {
          result: ok ? 'ready' : 'unavailable',
          totalMs: Math.round(performance.now() - startedAt),
        });
        if (ok) {
          resolve();
        } else {
          reject(
            new Error('The mesh inference route did not become responsive.')
          );
        }
      };
      const timeout = setTimeout(() => finish(false), 20_000);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (finished) {
          return;
        }
        try {
          const chunk = chunkSchema.parse(JSON.parse(line));
          if (chunk.type === 'timing') {
            log.info('Mesh warmup phase', {
              phase: chunk.phase,
              durationMs: chunk.durationMs,
              helperEventAtMs: Math.round(performance.now() - startedAt),
            });
          } else if (chunk.type === 'done') {
            finish(true);
          } else if (chunk.type === 'error') {
            finish(false);
          }
        } catch {
          finish(false);
        }
      });
      child.stderr.resume();
      child.stdin.on('error', () => finish(false));
      child.once('error', () => finish(false));
      child.once('close', () => {
        lines.close();
        finish(false);
      });
      child.stdin.end(
        `${JSON.stringify({ mode: 'warmup', provider: 'mesh-llm', ...inference })}\n`
      );
    });
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
    if (selectedProvider !== provider) {
      selectedProvider = provider;
      selectionGeneration += 1;
      // A free warmup must never survive a switch to the paid mesh. Also stop
      // old mesh questions before changing their loopback destination/policy.
      for (const child of warmChildren) {
        child.kill();
      }
      for (const [requestId, requestProvider] of requestProviders) {
        if (requestProvider !== 'chatgpt') {
          starting.delete(requestId);
          children.get(requestId)?.kill();
        }
      }
    }
    const generation = selectionGeneration;
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
      children.has(parsed.data.requestId) ||
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
      await mesh.configure(provider);
      if (
        generation !== selectionGeneration ||
        !starting.has(requestId) ||
        provider !== selectedProvider
      ) {
        throw new Error('The inference provider changed.');
      }
      runtime = loadRuntime(provider);
      if (!existsSync(runtime.binary)) {
        starting.delete(requestId);
        requestProviders.delete(requestId);
        return {
          ok: false,
          error: 'The local Sig agent is missing from this build.',
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
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.BRAVE_SEARCH_API_KEY;
    if (provider === 'chatgpt') {
      env.OPENAI_API_KEY = runtime.apiKey;
    }
    if (runtime.braveApiKey) {
      env.BRAVE_SEARCH_API_KEY = runtime.braveApiKey;
    }
    const child = spawn(runtime.binary, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.set(requestId, child);
    let completed = false;
    let receivedText = false;
    let modelTurns = 0;
    const finish = (message?: string) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      children.delete(requestId);
      requestProviders.delete(requestId);
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
      finish('Sig took too long. Please try again.');
      child.kill();
    }, 180_000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (completed) {
        return;
      }
      try {
        const chunk = chunkSchema.parse(JSON.parse(line));
        if (chunk.type === 'text') {
          if (!receivedText && chunk.text) {
            receivedText = true;
            log.info('Inference first text received', {
              provider,
              helperToFirstTextMs: Math.round(performance.now() - preparedAt),
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
            helperEventAtMs: Math.round(performance.now() - preparedAt),
            ...(chunk.phase === 'model-turn' ? { modelTurn: modelTurns } : {}),
          });
        } else if (chunk.type === 'error') {
          finish(chunk.message);
        } else {
          finish();
        }
      } catch {
        finish('Sig returned an unreadable response.');
        child.kill();
      }
    });
    // Discard provider diagnostics: they can contain prompt or credential data.
    child.stderr.resume();
    child.stdin.on('error', () => finish('Sig could not read this request.'));
    child.once('error', () => finish('The local Sig agent could not start.'));
    child.once('close', () => {
      lines.close();
      finish('Sig stopped before completing its response.');
    });
    child.stdin.end(
      `${JSON.stringify({
        prompt,
        provider: provider === 'chatgpt' ? 'chatgpt' : 'mesh-llm',
        author,
        history,
        currentDate: new Date().toISOString().slice(0, 10),
        ...(inference ?? { model: runtime.model }),
      })}\n`
    );
    return { ok: true };
  });
  ipcMain.on('sig-demo-agent:cancel', (event, requestId: unknown) => {
    if (
      event.sender === getMainWebContents() &&
      typeof requestId === 'string'
    ) {
      starting.delete(requestId);
      children.get(requestId)?.kill();
    }
  });
  app.on('before-quit', () => {
    starting.clear();
    requestProviders.clear();
    mesh.stop();
    for (const child of children.values()) {
      child.kill();
    }
    for (const child of warmChildren) {
      child.kill();
    }
  });
}
