// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

/* oxlint-disable no-await-in-loop -- Process shutdown, readiness, and peer connection polling must be sequential. */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { z } from 'zod';

import { getAppRootDir } from '../ts/util/appRootDir.main.ts';
import { createLogger } from '../ts/logging/log.std.ts';
import { sleep } from '../ts/util/sleep.std.ts';
import { strictAssert } from '../ts/util/assert.std.ts';

const log = createLogger('SigDemoMesh');
const runFile = promisify(execFile);
const API_PORT = 9337;
const CONSOLE_PORT = 3131;
const BASE_URL = `http://127.0.0.1:${API_PORT}/v1`;
const CONTROL_URL = `http://127.0.0.1:${CONSOLE_PORT}`;

const discoverySchema = z.array(
  z.object({
    listing: z.object({
      invite_token: z.string().min(1).max(32_768),
      serving: z.array(z.string()),
      node_count: z.number().nonnegative(),
      client_count: z.number().nonnegative().default(0),
      max_clients: z.number().nonnegative().default(0),
    }),
    expires_at: z.number().nullable().optional(),
  })
);
const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(1024),
      owned_by: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      payment: z
        .object({
          offers: z.array(
            z.object({
              provider_id: z.string(),
              paid: z.boolean(),
              local: z.boolean(),
            })
          ),
        })
        .optional(),
    })
  ),
});

export type SigDemoMeshInferenceType = Readonly<{
  baseUrl: string;
  model: string;
  targetNodeId: string;
}>;

async function matchingProcesses(): Promise<Array<number>> {
  if (!process.getuid) {
    throw new Error('The bundled mesh currently requires macOS.');
  }
  try {
    const { stdout } = await runFile('/usr/bin/pgrep', [
      '-u',
      String(process.getuid()),
      '-x',
      'mesh-llm',
    ]);
    return stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(pid => Number.isSafeInteger(pid) && pid > 0);
  } catch (error) {
    // pgrep uses exit status 1 when no process matches.
    if (
      typeof error === 'object' &&
      error != null &&
      'code' in error &&
      error.code === 1
    ) {
      return [];
    }
    throw new Error('Sig could not check for an existing mesh process.');
  }
}

/** The user explicitly chose to replace their existing mesh processes. */
async function stopExistingMeshProcesses(): Promise<void> {
  const targets = new Set(await matchingProcesses());
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // A matching process can exit between pgrep and the signal.
    }
  }
  const deadline = Date.now() + 5000;
  let remaining = [...targets];
  while (remaining.length && Date.now() < deadline) {
    await sleep(200);
    remaining = (await matchingProcesses()).filter(pid => targets.has(pid));
  }
  for (const pid of remaining) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // As above, do not signal unrelated or newly started processes.
    }
  }
  if (remaining.length) {
    await sleep(200);
  }
}

async function readJson(url: string, timeout = 5000): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error('The mesh is not ready.');
  }
  return response.json();
}

function failureReason(error: unknown): string {
  if (error instanceof z.ZodError) {
    return 'invalid_catalog';
  }
  if (error instanceof Error) {
    switch (error.message) {
      case 'The mesh client did not become ready.':
        return 'startup_timeout';
      case 'The mesh client stopped during startup.':
        return 'startup_stopped';
      case 'A mesh port is already in use by another application.':
        return 'port_in_use';
      case 'The mesh was stopped.':
        return 'cancelled';
      default:
        break;
    }
  }
  return 'network_unavailable';
}

function signalOwnedGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null) {
    return;
  }
  try {
    // detached:true makes this child the leader of a private process group.
    // Include any helper processes even after the group leader exits.
    process.kill(-child.pid, signal);
  } catch {
    // The owned group may have already exited.
  }
}

function ownedGroupAlive(child: ChildProcess): boolean {
  if (child.pid == null) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function requireAvailablePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => {
      reject(
        new Error('A mesh port is already in use by another application.')
      );
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
}

function shuffle<T>(values: ReadonlyArray<T>): Array<T> {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    const left = result[index];
    const right = result[other];
    strictAssert(left !== undefined && right !== undefined, 'Invalid shuffle');
    [result[index], result[other]] = [right, left];
  }
  return result;
}

/** Owns the bundled client; prompts go only to the explicitly selected peer. */
export class SigDemoMesh {
  #child: ChildProcess | undefined;
  #initializePromise: Promise<void> | undefined;
  #connectionPromise: Promise<SigDemoMeshInferenceType> | undefined;
  #selected: SigDemoMeshInferenceType | undefined;
  #stopped = false;
  #replacedExisting = false;
  readonly #directory = join(app.getPath('userData'), 'mesh');
  readonly #binary = app.isPackaged
    ? join(process.resourcesPath, 'sig-demo-mesh', 'mesh-llm')
    : join(getAppRootDir(), '.sig-demo/mesh/v0.78.1/mesh-bundle/mesh-llm');

  async start(): Promise<void> {
    await this.getInference();
  }

  async getInference(): Promise<SigDemoMeshInferenceType> {
    this.#stopped = false;
    if (!this.#initializePromise) {
      this.#initializePromise = this.#initialize();
    }
    try {
      await this.#initializePromise;
    } catch {
      this.#initializePromise = undefined;
      throw new Error('The bundled mesh could not start. Please try again.');
    }
    if (
      this.#selected &&
      this.#child &&
      this.#child.exitCode == null &&
      this.#child.signalCode == null
    ) {
      try {
        const routes = await this.#availableRoutes();
        const current = this.#selected;
        if (
          routes.some(
            route =>
              route.targetNodeId === current.targetNodeId &&
              route.model === current.model
          )
        ) {
          return current;
        }
      } catch {
        // Rediscover after a peer or sidecar disconnects.
      }
      this.#selected = undefined;
    }
    if (!this.#connectionPromise) {
      this.#connectionPromise = this.#connect();
    }
    try {
      return await this.#connectionPromise;
    } finally {
      this.#connectionPromise = undefined;
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#selected = undefined;
    this.#initializePromise = undefined;
    if (this.#child) {
      signalOwnedGroup(this.#child, 'SIGTERM');
    }
  }

  async #initialize(): Promise<void> {
    if (!existsSync(this.#binary)) {
      throw new Error('The mesh binary is missing.');
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (!this.#replacedExisting) {
      await stopExistingMeshProcesses();
      this.#replacedExisting = true;
    }
    await writeFile(
      join(this.#directory, 'config.toml'),
      '[runtime]\nmode = "client"\nlisten_all = false\n' +
        '[analytics]\nenabled = false\n[logging]\nenabled = false\n' +
        '[[plugin]]\nname = "blobstore"\nenabled = false\n' +
        '[[plugin]]\nname = "payments"\nenabled = false\n',
      { mode: 0o600 }
    );
    // The discovery process must not implicitly rejoin yesterday's token.
    await rm(join(this.#directory, 'invite.token'), { force: true });
    await this.#launch();
    log.info('Bundled mesh client started');
  }

  #environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    // Do not pass provider credentials, wallet settings, or another mesh's
    // environment overrides into this network-facing child.
    for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']) {
      env[name] = process.env[name];
    }
    const isolated = (name: string) => join(this.#directory, name);
    return {
      ...env,
      MESH_LLM_NODE_KEY_PATH: isolated('node.key'),
      MESH_LLM_RUNTIME_ROOT: isolated('runtime'),
      MESH_LLM_DATA_DIR: isolated('data'),
      MESH_LLM_PLUGIN_DIR: isolated('plugins'),
      MESH_LLM_NATIVE_RUNTIME_CACHE_DIR: isolated('native-runtimes'),
      MESH_LLM_HASH_CACHE_DIR: isolated('hash-cache'),
      MESH_LLM_HOME: this.#directory,
      HF_HUB_CACHE: isolated('hf-hub'),
      HF_XET_CACHE: isolated('hf-xet'),
      MESH_LLM_NO_DEFAULT_PLUGINS: '1',
      MESH_LLM_ANALYTICS: '0',
      DO_NOT_TRACK: '1',
    };
  }

  async #launch(token?: string): Promise<void> {
    if (this.#stopped) {
      throw new Error('The mesh was stopped.');
    }
    await this.#stopOwnedChild();
    if (this.#stopped) {
      throw new Error('The mesh was stopped.');
    }
    await Promise.all([
      requireAvailablePort(API_PORT),
      requireAvailablePort(CONSOLE_PORT),
    ]);
    const args = [
      'client',
      '--port',
      String(API_PORT),
      '--console',
      String(CONSOLE_PORT),
      '--bind-port',
      '0',
      '--headless',
      '--no-default-plugins',
      '--no-enumerate-host',
      '--config',
      join(this.#directory, 'config.toml'),
      '--owner-key',
      join(this.#directory, 'unused-owner-keystore.json'),
      '--trust-policy',
      'off',
      '--log-format',
      'json',
    ];
    if (token) {
      const path = join(this.#directory, 'selected-mesh.token');
      await writeFile(path, token, { mode: 0o600 });
      args.push('--join-file', path);
    }
    if (this.#stopped) {
      throw new Error('The mesh was stopped.');
    }
    const child = spawn(this.#binary, args, {
      cwd: this.#directory,
      env: this.#environment(),
      stdio: 'ignore',
      detached: true,
    });
    this.#child = child;
    let failed = false;
    child.once('error', () => {
      failed = true;
    });
    // Upstream retries three 30-second QUIC handshakes, with 5/10-second
    // backoffs, before binding its local management and inference endpoints.
    const deadline = Date.now() + (token ? 110_000 : 20_000);
    while (Date.now() < deadline) {
      if (
        this.#stopped ||
        failed ||
        child.exitCode != null ||
        child.signalCode != null
      ) {
        throw new Error('The mesh client stopped during startup.');
      }
      try {
        await readJson(`${CONTROL_URL}/health`, 1500);
        return;
      } catch {
        await sleep(200);
      }
    }
    signalOwnedGroup(child, 'SIGTERM');
    throw new Error('The mesh client did not become ready.');
  }

  async #stopOwnedChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (!child) {
      return;
    }
    signalOwnedGroup(child, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (ownedGroupAlive(child) && Date.now() < deadline) {
      await sleep(100);
    }
    if (ownedGroupAlive(child)) {
      signalOwnedGroup(child, 'SIGKILL');
      await sleep(100);
    }
  }

  async #availableRoutes(): Promise<Array<SigDemoMeshInferenceType>> {
    const models = modelsSchema.parse(await readJson(`${BASE_URL}/models`));
    const routes: Array<SigDemoMeshInferenceType> = [];
    for (const model of models.data) {
      if (
        model.id === 'mesh' ||
        model.id === 'auto' ||
        model.id.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(model.id) ||
        model.owned_by?.startsWith('plugin:') ||
        !model.capabilities?.includes('text')
      ) {
        continue;
      }
      for (const offer of model.payment?.offers ?? []) {
        if (
          !offer.paid &&
          !offer.local &&
          /^[a-fA-F0-9]{64}$/.test(offer.provider_id)
        ) {
          routes.push({
            baseUrl: BASE_URL,
            model: model.id,
            targetNodeId: offer.provider_id,
          });
        }
      }
    }
    return routes;
  }

  async #connect(): Promise<SigDemoMeshInferenceType> {
    try {
      if (
        !this.#child ||
        this.#child.exitCode != null ||
        this.#child.signalCode != null
      ) {
        await this.#launch();
      }
      // A failed selected peer can leave other free nodes in the same mesh
      // reachable. Reuse that connection before restarting discovery.
      try {
        const selected = this.#selectRoute(await this.#availableRoutes());
        if (selected && !this.#stopped) {
          return selected;
        }
      } catch {
        // A bare discovery client can have no OpenAI models endpoint yet.
      }
      const discovered = discoverySchema.parse(
        await readJson(`${CONTROL_URL}/api/discover`, 25_000)
      );
      const now = Date.now() / 1000;
      const meshes = shuffle(
        discovered.filter(
          mesh =>
            mesh.listing.serving.length > 0 &&
            mesh.listing.node_count > 0 &&
            (!mesh.expires_at || mesh.expires_at > now) &&
            (mesh.listing.max_clients === 0 ||
              mesh.listing.client_count < mesh.listing.max_clients)
        )
      );
      // Bound startup time for a demo while giving stale public adverts a
      // chance to be skipped. Each attempt only restarts our own child.
      for (const mesh of meshes.slice(0, 2)) {
        if (this.#stopped) {
          throw new Error('The mesh was stopped.');
        }
        try {
          await this.#launch(mesh.listing.invite_token);
          // Management liveness can become ready before the join has started
          // its inference proxy. Keep polling through that transient window.
          const deadline = Date.now() + 55_000;
          while (Date.now() < deadline && !this.#stopped) {
            try {
              const routes = await this.#availableRoutes();
              const selected = this.#selectRoute(routes);
              if (selected && !this.#stopped) {
                return selected;
              }
            } catch {
              // The local OpenAI port and model gossip can lag /health.
            }
            await sleep(500);
          }
        } catch (error) {
          log.info(
            'Public mesh candidate unavailable; trying another',
            failureReason(error)
          );
        }
      }
    } catch (error) {
      log.info('Public mesh discovery unavailable', failureReason(error));
    }
    throw new Error(
      'No available mesh node was found. Try again, or choose ChatGPT in Settings → General → Inference.'
    );
  }

  #selectRoute(
    routes: ReadonlyArray<SigDemoMeshInferenceType>
  ): SigDemoMeshInferenceType | undefined {
    if (this.#stopped || !routes.length) {
      return undefined;
    }
    const nodes = [...new Set(routes.map(route => route.targetNodeId))];
    const selectedNode = nodes[randomInt(nodes.length)];
    const nodeRoutes = routes.filter(
      route => route.targetNodeId === selectedNode
    );
    const selected = nodeRoutes[randomInt(nodeRoutes.length)];
    strictAssert(selected, 'No available mesh route');
    this.#selected = selected;
    log.info('Connected to an available public mesh node');
    return selected;
  }
}
