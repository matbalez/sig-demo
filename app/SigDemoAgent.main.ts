// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { app, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { z } from 'zod';

import {
  SIG_DEMO_AGENT_MODEL,
  type SigDemoAgentEventType,
} from '../ts/types/SigDemoAgent.std.ts';
import { getAppRootDir } from '../ts/util/appRootDir.main.ts';

const requestSchema = z.object({
  requestId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(65_536),
});
const chunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
const runtimeSchema = z.object({
  apiKey: z.string().min(20),
  model: z.string().min(1).default(SIG_DEMO_AGENT_MODEL),
});

function loadRuntime() {
  const root = getAppRootDir();
  if (app.isPackaged) {
    const directory = join(process.resourcesPath, 'sig-demo-agent');
    const runtime = runtimeSchema.parse(
      JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
    );
    return { ...runtime, binary: join(directory, 'sig-demo-agent') };
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
    binary: join(root, 'sig-demo/agent/target/release/sig-demo-agent'),
  };
}

/** The credential stays in the main process and its local GDK child only. */
export function setupSigDemoAgent(
  getMainWebContents: () => WebContents | undefined
): void {
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  ipcMain.handle('sig-demo-agent:start', (event, value: unknown) => {
    const parsed = requestSchema.safeParse(value);
    if (
      !parsed.success ||
      event.sender !== getMainWebContents() ||
      event.senderFrame !== event.sender.mainFrame ||
      children.has(parsed.data.requestId)
    ) {
      return { ok: false, error: 'Sig could not start this request.' };
    }
    const { requestId, prompt } = parsed.data;
    let runtime: ReturnType<typeof loadRuntime>;
    try {
      runtime = loadRuntime();
      if (!existsSync(runtime.binary)) {
        return {
          ok: false,
          error: 'The local Sig agent is missing from this build.',
        };
      }
    } catch {
      return { ok: false, error: 'Sig is not configured in this build.' };
    }
    const child = spawn(runtime.binary, [], {
      env: { ...process.env, OPENAI_API_KEY: runtime.apiKey },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.set(requestId, child);
    let completed = false;
    const send = (chunk: SigDemoAgentEventType) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('sig-demo-agent:event', chunk);
      }
    };
    const finish = (message?: string) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      children.delete(requestId);
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
          send({ requestId, type: 'text', text: chunk.text });
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
    child.stdin.end(`${JSON.stringify({ prompt, model: runtime.model })}\n`);
    return { ok: true };
  });
  ipcMain.on('sig-demo-agent:cancel', (event, requestId: unknown) => {
    if (
      event.sender === getMainWebContents() &&
      typeof requestId === 'string'
    ) {
      children.get(requestId)?.kill();
    }
  });
  app.on('before-quit', () => {
    for (const child of children.values()) {
      child.kill();
    }
  });
}
