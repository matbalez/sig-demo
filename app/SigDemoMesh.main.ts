// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

/* oxlint-disable no-await-in-loop -- Process shutdown, readiness, and peer connection polling must be sequential. */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { z } from 'zod';

import { getAppRootDir } from '../ts/util/appRootDir.main.ts';
import { createLogger } from '../ts/logging/log.std.ts';
import { sleep } from '../ts/util/sleep.std.ts';
import { strictAssert } from '../ts/util/assert.std.ts';
import { drop } from '../ts/util/drop.std.ts';
import {
  parseSigDemoMeshBootstrapCache,
  selectSigDemoMeshBootstrapTokens,
} from '../ts/util/sigDemoMeshBootstrap.node.ts';
import {
  getSigDemoMeshOptionId,
  parseSigDemoMeshCatalog,
  parseSigDemoMeshOptionId,
} from '../ts/util/sigDemoMeshCatalog.std.ts';
import { parseSigDemoPaidMeshConfig } from '../ts/util/sigDemoMeshPaidConfig.std.ts';
import { enrichSigDemoMeshNodeDetails } from '../ts/util/sigDemoMeshNodeDetails.std.ts';
import type { SigDemoInferenceProviderType } from '../ts/types/SigDemoAgent.std.ts';
import type {
  SigDemoMeshCatalogType,
  SigDemoMeshOptionType,
  SigDemoMeshProviderType,
} from '../ts/types/SigDemoMesh.std.ts';
import type {
  SigDemoWalletInvoiceType,
  SigDemoWalletSnapshotType,
} from '../ts/types/SigDemoWallet.std.ts';
import { SigDemoMeshWallet } from './SigDemoMeshWallet.node.ts';

const log = createLogger('SigDemoMesh');
const runFile = promisify(execFile);
const API_PORT = 9337;
const CONSOLE_PORT = 3131;
const BASE_URL = `http://127.0.0.1:${API_PORT}/v1`;
const CONTROL_URL = `http://127.0.0.1:${CONSOLE_PORT}`;
type MeshMode = 'free' | 'paid';
type PaidConfig = ReturnType<typeof parseSigDemoPaidMeshConfig>;
type PaidNode = PaidConfig['nodes'][number];

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

/** Owns the bundled client; prompts go only to the explicitly selected peer. */
export class SigDemoMesh {
  #child: ChildProcess | undefined;
  #connectionPromise: Promise<SigDemoMeshInferenceType> | undefined;
  #preparationPromise: Promise<SigDemoMeshInferenceType> | undefined;
  #qualifiedRouteKey: string | undefined;
  #selected: SigDemoMeshInferenceType | undefined;
  #availableNodeIds: Array<string> = [];
  #startedFromCache = false;
  #cacheRefreshPromise: Promise<void> | undefined;
  #stopped = false;
  #replacedExisting = false;
  #generation = 0;
  #requestedProvider: SigDemoInferenceProviderType = 'mesh-llm';
  #configuredProvider: SigDemoInferenceProviderType | undefined;
  #mode: MeshMode | undefined;
  #expectedPaidNodeId: string | undefined;
  #paidModel: string | undefined;
  #paidSource: PaidNode | undefined;
  #paidConfiguration: PaidConfig | undefined;
  readonly #selectionIds = new Map<SigDemoInferenceProviderType, string>();
  #configurationPromise: Promise<void> | undefined;
  #configurationTail: Promise<void> = Promise.resolve();
  #walletInstalled = false;
  readonly #directory = join(app.getPath('userData'), 'mesh');
  readonly #binary = app.isPackaged
    ? join(process.resourcesPath, 'sig-demo-mesh', 'mesh-llm')
    : join(getAppRootDir(), '.sig-demo/mesh/v0.78.1/mesh-bundle/mesh-llm');
  readonly #wallet = new SigDemoMeshWallet(
    this.#binary,
    this.#directory,
    CONSOLE_PORT,
    () => this.#environment()
  );

  async configure(
    provider: SigDemoInferenceProviderType,
    selectionId?: string
  ): Promise<void> {
    const previousSelection = this.#selectionIds.get(provider);
    const selection =
      selectionId === undefined ? previousSelection : selectionId || undefined;
    if (selection && !parseSigDemoMeshOptionId(selection)) {
      throw new Error('The selected mesh model or node is invalid.');
    }
    const selectionChanged = previousSelection !== selection;
    if (selection) this.#selectionIds.set(provider, selection);
    else this.#selectionIds.delete(provider);
    if (
      !this.#stopped &&
      !selectionChanged &&
      provider === this.#requestedProvider &&
      this.#configurationPromise
    ) {
      return this.#configurationPromise;
    }
    const liveChild =
      this.#child &&
      this.#child.exitCode == null &&
      this.#child.signalCode == null;
    if (
      !this.#stopped &&
      !selectionChanged &&
      provider === this.#configuredProvider &&
      provider === this.#requestedProvider &&
      (liveChild || provider === 'chatgpt')
    ) {
      return;
    }
    this.#requestedProvider = provider;
    this.#stopped = false;
    this.#generation += 1;
    const generation = this.#generation;
    this.#selected = undefined;
    this.#qualifiedRouteKey = undefined;
    this.#connectionPromise = undefined;
    this.#preparationPromise = undefined;
    const configure = this.#enqueue(() =>
      this.#configure(provider, generation)
    );
    this.#configurationPromise = configure;
    try {
      await configure;
    } finally {
      if (this.#configurationPromise === configure) {
        this.#configurationPromise = undefined;
      }
    }
  }

  #assertCurrent(generation: number): void {
    if (this.#stopped || generation !== this.#generation) {
      throw new Error('The mesh was stopped.');
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.#configurationTail;
    const queued = (async () => {
      try {
        await previous;
      } catch {
        // A failed selection must not prevent a later selection from retrying.
      }
      await operation();
    })();
    this.#configurationTail = (async () => {
      try {
        await queued;
      } catch {
        // The caller receives this operation's error; the queue stays usable.
      }
    })();
    return queued;
  }

  async #configure(
    provider: SigDemoInferenceProviderType,
    generation: number
  ): Promise<void> {
    this.#assertCurrent(generation);
    if (!existsSync(this.#binary)) {
      throw new Error('The mesh binary is missing.');
    }
    const mode = provider === 'mesh-llm-paid' ? 'paid' : 'free';
    const paidConfig = mode === 'paid' ? await this.#paidConfig() : undefined;
    this.#assertCurrent(generation);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (!this.#replacedExisting) {
      await stopExistingMeshProcesses();
      this.#assertCurrent(generation);
      this.#replacedExisting = true;
    }
    const installed = await this.#wallet.ensureInstalled();
    this.#assertCurrent(generation);
    if (!installed && mode === 'paid') {
      throw new Error(
        'The local wallet could not be installed. Please try again.'
      );
    }
    const childAlive =
      this.#child &&
      this.#child.exitCode == null &&
      this.#child.signalCode == null;
    const selected = parseSigDemoMeshOptionId(
      this.#selectionIds.get(provider) ?? ''
    );
    const defaultPaidNode =
      paidConfig?.nodes.find(
        node => node.expectedNodeId === paidConfig.defaultNodeId
      ) ?? paidConfig?.nodes[0];
    let paidSource = selected
      ? (paidConfig?.nodes.find(
          node =>
            node.model === selected.model &&
            node.expectedNodeId === selected.nodeId
        ) ?? defaultPaidNode)
      : defaultPaidNode;
    const wantedPaidRoute =
      selected ??
      (defaultPaidNode?.expectedNodeId
        ? {
            model: defaultPaidNode.model,
            nodeId: defaultPaidNode.expectedNodeId,
          }
        : undefined);
    if (
      mode === 'paid' &&
      childAlive &&
      this.#mode === 'paid' &&
      this.#paidSource &&
      wantedPaidRoute
    ) {
      try {
        const live = parseSigDemoMeshCatalog(
          await readJson(`${BASE_URL}/models`),
          true
        );
        this.#assertCurrent(generation);
        if (
          live.some(
            option =>
              option.model === wantedPaidRoute.model &&
              option.nodeId === wantedPaidRoute.nodeId
          )
        ) {
          // Several configured peers may already share this membership. Pin the
          // chosen route without restarting a healthy owned client.
          paidSource = this.#paidSource;
        }
      } catch {
        this.#assertCurrent(generation);
      }
    }
    const restart =
      !childAlive ||
      this.#mode !== mode ||
      installed !== this.#walletInstalled ||
      (mode === 'paid' &&
        this.#paidSource?.inviteToken !== paidSource?.inviteToken);
    if (restart) {
      await this.#stopOwnedChild();
      this.#assertCurrent(generation);
    }
    this.#walletInstalled = installed;
    await this.#writeConfig(installed);
    this.#assertCurrent(generation);
    if (provider === 'chatgpt' && !this.#child) {
      if (installed) {
        await this.#wallet.setPolicy(undefined, false);
      }
      this.#assertCurrent(generation);
      this.#mode = 'free';
      this.#expectedPaidNodeId = undefined;
      this.#paidModel = undefined;
      this.#paidSource = undefined;
      this.#configuredProvider = provider;
      return;
    }
    if (restart) {
      await rm(join(this.#directory, 'invite.token'), { force: true });
      this.#assertCurrent(generation);
      if (mode === 'paid') {
        strictAssert(paidSource, 'Missing paid mesh configuration');
        this.#startedFromCache = false;
        await this.#launch(mode, [paidSource.inviteToken], generation);
      } else {
        let tokens: Array<string> | undefined;
        try {
          tokens = parseSigDemoMeshBootstrapCache(
            JSON.parse(
              await readFile(
                join(this.#directory, 'bootstrap-cache.json'),
                'utf8'
              )
            ),
            Date.now()
          );
        } catch {
          // Fresh installs use normal public discovery.
        }
        this.#assertCurrent(generation);
        this.#startedFromCache = tokens !== undefined;
        try {
          await this.#launch(mode, tokens, generation);
        } catch (error) {
          this.#assertCurrent(generation);
          if (!tokens) {
            throw error;
          }
          this.#startedFromCache = false;
          await rm(join(this.#directory, 'bootstrap-cache.json'), {
            force: true,
          });
          await this.#launch(mode, undefined, generation);
        }
      }
    }
    this.#assertCurrent(generation);
    if (installed) {
      await this.#wallet.setPolicy(this.#child?.pid, mode === 'paid');
      this.#assertCurrent(generation);
    }
    this.#mode = mode;
    this.#paidConfiguration = paidConfig ?? this.#paidConfiguration;
    this.#expectedPaidNodeId =
      mode === 'paid'
        ? (selected?.nodeId ?? defaultPaidNode?.expectedNodeId)
        : undefined;
    this.#paidModel =
      mode === 'paid' ? (selected?.model ?? defaultPaidNode?.model) : undefined;
    this.#paidSource = mode === 'paid' ? paidSource : undefined;
    this.#configuredProvider = provider;
    log.info('Bundled mesh client configured', { mode });
  }

  async #paidConfig(): Promise<PaidConfig> {
    try {
      const path = app.isPackaged
        ? join(process.resourcesPath, 'sig-demo-mesh/paid.json')
        : join(getAppRootDir(), '.sig-demo/mesh-paid.json');
      return parseSigDemoPaidMeshConfig(
        JSON.parse(await readFile(path, 'utf8'))
      );
    } catch {
      throw new Error('The private paid mesh is not configured in this build.');
    }
  }

  async #writeConfig(wallet: boolean): Promise<void> {
    await writeFile(
      join(this.#directory, 'config.toml'),
      '[runtime]\nmode = "client"\nlisten_all = false\n' +
        '[analytics]\nenabled = false\n[logging]\nenabled = false\n' +
        (wallet ? '[payments]\nwallet = "lexe-wallet"\n' : '') +
        '[[plugin]]\nname = "blobstore"\nenabled = false\n' +
        `[[plugin]]\nname = "payments"\nenabled = ${wallet ? 'true' : 'false'}\n`,
      { mode: 0o600 }
    );
  }

  async #walletRuntime(): Promise<{ pid: number; generation: number }> {
    const provider = this.#requestedProvider;
    await this.configure(provider);
    if (!this.#walletInstalled) {
      // A failed download does not block free chat; Wallet can retry it later.
      this.#configuredProvider = undefined;
      await this.configure(provider);
    }
    if (!this.#walletInstalled) {
      throw new Error(
        'The local wallet could not be installed. Please try again.'
      );
    }
    const generation = this.#generation;
    const prepare = this.#enqueue(async () => {
      this.#assertCurrent(generation);
      if (
        !this.#child ||
        this.#child.exitCode != null ||
        this.#child.signalCode != null
      ) {
        // ChatGPT startup installs the plugin without joining a mesh. Opening
        // Wallet starts a free client so its local operator API owns the wallet.
        await this.#launch('free', undefined, generation);
        await this.#wallet.setPolicy(this.#child?.pid, false);
        this.#assertCurrent(generation);
        this.#mode = 'free';
      }
    });
    await prepare;
    this.#assertCurrent(generation);
    const pid = this.#child?.pid;
    strictAssert(pid != null, 'Missing local wallet process');
    return { pid, generation };
  }

  async getWalletSnapshot(): Promise<SigDemoWalletSnapshotType> {
    try {
      const { pid, generation } = await this.#walletRuntime();
      const snapshot = await this.#wallet.snapshot(pid);
      this.#assertCurrent(generation);
      return snapshot;
    } catch {
      throw new Error('The local wallet is unavailable. Please try again.');
    }
  }

  async fundWallet(amountSats: number): Promise<SigDemoWalletInvoiceType> {
    try {
      const { pid, generation } = await this.#walletRuntime();
      const invoice = await this.#wallet.fund(pid, amountSats);
      this.#assertCurrent(generation);
      return invoice;
    } catch {
      throw new Error(
        'The wallet could not create an invoice. Please try again.'
      );
    }
  }

  async start(): Promise<void> {
    await this.getInference();
  }

  async getInference(
    provider: SigDemoInferenceProviderType = 'mesh-llm',
    selectionId?: string
  ): Promise<SigDemoMeshInferenceType> {
    await this.configure(provider, selectionId);
    const generation = this.#generation;
    this.#assertCurrent(generation);
    if (
      this.#selected &&
      this.#child &&
      this.#child.exitCode == null &&
      this.#child.signalCode == null
    ) {
      try {
        const routes = await this.#availableRoutes(generation);
        this.#assertCurrent(generation);
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
      this.#assertCurrent(generation);
      this.#selected = undefined;
      this.#qualifiedRouteKey = undefined;
    }
    if (!this.#connectionPromise) {
      this.#connectionPromise = this.#connect(generation);
    }
    const connection = this.#connectionPromise;
    try {
      return await connection;
    } finally {
      if (this.#connectionPromise === connection) {
        this.#connectionPromise = undefined;
      }
    }
  }

  /** Refresh metadata only: no inference, warmup, provider switch, or payment. */
  async getInferenceOptions(
    provider: SigDemoMeshProviderType
  ): Promise<SigDemoMeshCatalogType> {
    const paid = provider === 'mesh-llm-paid';
    const configuration = paid
      ? (this.#paidConfiguration ?? (await this.#paidConfig()))
      : undefined;
    const options = new Map<string, SigDemoMeshOptionType>();
    let status: unknown;
    if (
      provider === this.#requestedProvider &&
      this.#child &&
      this.#child.exitCode == null &&
      this.#child.signalCode == null
    ) {
      const [catalogResult, statusResult] = await Promise.allSettled([
        this.#liveOptions(),
        readJson(`${CONTROL_URL}/api/status`, 1500),
      ]);
      if (catalogResult.status === 'fulfilled') {
        for (const option of catalogResult.value)
          options.set(option.id, option);
      } else {
        // Offline configured/selected entries remain visible and retryable.
      }
      if (statusResult.status === 'fulfilled') status = statusResult.value;
    }
    for (const node of configuration?.nodes ?? []) {
      if (!node.expectedNodeId) continue;
      const id = getSigDemoMeshOptionId(node.model, node.expectedNodeId);
      const current = options.get(id);
      options.set(id, {
        id,
        model: node.model,
        nodeId: node.expectedNodeId,
        paid: true,
        available: false,
        ...current,
        label: node.label,
        hosting: node.hosting,
        hardware: node.hardware,
      });
    }
    const selectionId = this.#selectionIds.get(provider);
    const selection = selectionId
      ? parseSigDemoMeshOptionId(selectionId)
      : undefined;
    if (selectionId && selection && !options.has(selectionId)) {
      options.set(selectionId, {
        id: selectionId,
        model: selection.model,
        nodeId: selection.nodeId,
        paid,
        available: false,
      });
    }
    let activeId: string | undefined;
    if (provider === this.#requestedProvider) {
      if (this.#selected) {
        activeId = getSigDemoMeshOptionId(
          this.#selected.model,
          this.#selected.targetNodeId
        );
      } else if (
        paid &&
        !selectionId &&
        this.#paidModel &&
        this.#expectedPaidNodeId
      ) {
        activeId = getSigDemoMeshOptionId(
          this.#paidModel,
          this.#expectedPaidNodeId
        );
      }
    }
    return {
      options: enrichSigDemoMeshNodeDetails([...options.values()], status).sort(
        (left, right) =>
          left.model.localeCompare(right.model) ||
          left.nodeId.localeCompare(right.nodeId)
      ),
      selectionId,
      activeId,
    };
  }

  async prepareInference(
    warm: (route: SigDemoMeshInferenceType) => Promise<void>,
    selectionId?: string
  ): Promise<SigDemoMeshInferenceType> {
    if (this.#requestedProvider !== 'mesh-llm') {
      throw new Error('Only free mesh inference is warmed.');
    }
    if (
      selectionId !== undefined &&
      (selectionId || undefined) !== this.#selectionIds.get('mesh-llm')
    ) {
      await this.configure('mesh-llm', selectionId);
    }
    if (!this.#preparationPromise) {
      this.#preparationPromise = this.#prepareInference(warm, selectionId);
    }
    const preparation = this.#preparationPromise;
    try {
      return await preparation;
    } finally {
      if (this.#preparationPromise === preparation) {
        this.#preparationPromise = undefined;
      }
    }
  }

  async #prepareInference(
    warm: (route: SigDemoMeshInferenceType) => Promise<void>,
    selectionId?: string
  ): Promise<SigDemoMeshInferenceType> {
    let candidate: SigDemoMeshInferenceType | undefined =
      await this.getInference('mesh-llm', selectionId);
    const generation = this.#generation;
    const routeKey = (route: SigDemoMeshInferenceType) =>
      `${route.targetNodeId}\u0000${route.model}`;
    if (this.#qualifiedRouteKey === routeKey(candidate)) {
      return candidate;
    }
    const child = this.#child;
    const attemptedNodes = new Set<string>();
    for (let attempt = 0; attempt < 2 && candidate; attempt += 1) {
      if (
        this.#stopped ||
        this.#child !== child ||
        generation !== this.#generation
      ) {
        throw new Error('The mesh was stopped.');
      }
      attemptedNodes.add(candidate.targetNodeId);
      try {
        await warm(candidate);
        if (
          this.#stopped ||
          this.#child !== child ||
          generation !== this.#generation
        ) {
          throw new Error('The mesh was stopped.');
        }
        this.#selected = candidate;
        this.#qualifiedRouteKey = routeKey(candidate);
        log.info('Public mesh inference warmed');
        return candidate;
      } catch {
        if (
          this.#stopped ||
          this.#child !== child ||
          generation !== this.#generation
        ) {
          throw new Error('The mesh was stopped.');
        }
        this.#selected = undefined;
        this.#qualifiedRouteKey = undefined;
        log.info('Public mesh inference slow or unavailable');
      }
      if (attempt === 0) {
        if (this.#selectionIds.get('mesh-llm')) break;
        try {
          candidate = this.#selectRoute(
            (await this.#availableRoutes(generation)).filter(
              route => !attemptedNodes.has(route.targetNodeId)
            )
          );
        } catch {
          candidate = undefined;
        }
      }
    }
    throw new Error(
      'No responsive mesh node is available. Try again, or choose ChatGPT in Settings → General → Inference.'
    );
  }

  stop(): void {
    this.#stopped = true;
    this.#generation += 1;
    this.#selected = undefined;
    this.#configuredProvider = undefined;
    this.#configurationPromise = undefined;
    this.#connectionPromise = undefined;
    this.#preparationPromise = undefined;
    this.#qualifiedRouteKey = undefined;
    if (this.#child) {
      signalOwnedGroup(this.#child, 'SIGTERM');
    }
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

  async #launch(
    mode: MeshMode,
    tokens: ReadonlyArray<string> | undefined,
    generation: number
  ): Promise<void> {
    if (mode === 'paid' && !tokens?.length) {
      throw new Error('The private paid mesh is not configured in this build.');
    }
    this.#qualifiedRouteKey = undefined;
    this.#assertCurrent(generation);
    await this.#stopOwnedChild();
    this.#assertCurrent(generation);
    await Promise.all([
      requireAvailablePort(API_PORT),
      requireAvailablePort(CONSOLE_PORT),
    ]);
    this.#assertCurrent(generation);
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
    if (tokens?.length) {
      for (const [index, token] of tokens.entries()) {
        const path = join(
          this.#directory,
          mode === 'paid' ? 'paid-invite.token' : `bootstrap-${index}.token`
        );
        await writeFile(path, token, { mode: 0o600 });
        this.#assertCurrent(generation);
        args.push('--join-file', path);
      }
    } else {
      // Upstream discovers several public bootstraps and races the first four,
      // avoiding the serial single-token path that blocks on peer gossip.
      args.push('--auto');
    }
    this.#assertCurrent(generation);
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
    // Fast client joins race up to four 30-second probes. Keep the full
    // upstream retry allowance only for a legacy single-token launch.
    const deadline = Date.now() + (tokens?.length === 1 ? 110_000 : 45_000);
    while (Date.now() < deadline) {
      this.#assertCurrent(generation);
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
        this.#assertCurrent(generation);
        return;
      } catch {
        this.#assertCurrent(generation);
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

  async #liveOptions(
    generation = this.#generation
  ): Promise<Array<SigDemoMeshOptionType>> {
    const options = parseSigDemoMeshCatalog(
      await readJson(`${BASE_URL}/models`),
      this.#mode === 'paid'
    );
    this.#assertCurrent(generation);
    return options;
  }

  async #availableRoutes(
    generation = this.#generation
  ): Promise<Array<SigDemoMeshInferenceType>> {
    const options = await this.#liveOptions(generation);
    const routes: Array<SigDemoMeshInferenceType> = options
      .filter(
        option =>
          this.#mode !== 'paid' ||
          (option.model === this.#paidModel &&
            (this.#expectedPaidNodeId === undefined ||
              option.nodeId === this.#expectedPaidNodeId))
      )
      .map(option => ({
        baseUrl: BASE_URL,
        model: option.model,
        targetNodeId: option.nodeId,
      }));
    this.#availableNodeIds = [
      ...new Set(routes.map(route => route.targetNodeId)),
    ];
    return routes;
  }

  async #waitForRoute(
    timeout: number,
    generation: number
  ): Promise<SigDemoMeshInferenceType | undefined> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !this.#stopped) {
      this.#assertCurrent(generation);
      try {
        const selected = this.#selectRoute(
          await this.#availableRoutes(generation)
        );
        if (selected) {
          return selected;
        }
      } catch {
        this.#assertCurrent(generation);
        // Inference listeners and admitted model advertisements can lag health.
      }
      await sleep(250);
    }
    return undefined;
  }

  async #connect(generation: number): Promise<SigDemoMeshInferenceType> {
    try {
      this.#assertCurrent(generation);
      if (
        !this.#child ||
        this.#child.exitCode != null ||
        this.#child.signalCode != null
      ) {
        this.#startedFromCache = false;
        const paidSource = this.#mode === 'paid' ? this.#paidSource : undefined;
        await this.#launch(
          this.#mode ?? 'free',
          paidSource ? [paidSource.inviteToken] : undefined,
          generation
        );
        if (this.#walletInstalled) {
          await this.#wallet.setPolicy(this.#child?.pid, this.#mode === 'paid');
        }
        this.#assertCurrent(generation);
      }
      // Also reuse another live peer in the current mesh if the selected one
      // disappeared. The route remains uniformly random across free nodes.
      let selected = await this.#waitForRoute(30_000, generation);
      if (selected) {
        return selected;
      }
      if (this.#mode !== 'paid' && this.#startedFromCache && !this.#stopped) {
        log.info('Cached mesh has no available model; refreshing discovery');
        this.#startedFromCache = false;
        await rm(join(this.#directory, 'bootstrap-cache.json'), {
          force: true,
        });
        await this.#launch('free', undefined, generation);
        if (this.#walletInstalled) {
          await this.#wallet.setPolicy(this.#child?.pid, false);
        }
        selected = await this.#waitForRoute(55_000, generation);
        if (selected) {
          return selected;
        }
      }
    } catch (error) {
      this.#assertCurrent(generation);
      log.info('Mesh discovery unavailable', failureReason(error));
    }
    throw new Error(
      this.#mode === 'paid'
        ? 'The paid mesh model is unavailable. Please try again.'
        : 'No available mesh node was found. Try again, or choose ChatGPT in Settings → General → Inference.'
    );
  }

  #selectRoute(
    routes: ReadonlyArray<SigDemoMeshInferenceType>
  ): SigDemoMeshInferenceType | undefined {
    if (this.#stopped || !routes.length) {
      return undefined;
    }
    const selectionId = this.#selectionIds.get(this.#requestedProvider);
    const selection = selectionId
      ? parseSigDemoMeshOptionId(selectionId)
      : undefined;
    let selected: SigDemoMeshInferenceType | undefined;
    if (selection) {
      selected = routes.find(
        route =>
          route.model === selection.model &&
          route.targetNodeId === selection.nodeId
      );
      if (!selected) return undefined;
    } else {
      const nodes = [...new Set(routes.map(route => route.targetNodeId))];
      const selectedNode = nodes[randomInt(nodes.length)];
      const nodeRoutes = routes.filter(
        route => route.targetNodeId === selectedNode
      );
      selected = nodeRoutes[randomInt(nodeRoutes.length)];
    }
    strictAssert(selected, 'No available mesh route');
    this.#selected = selected;
    log.info('Connected to an available mesh node', {
      mode: this.#mode ?? 'free',
    });
    if (this.#mode !== 'paid' && !this.#cacheRefreshPromise) {
      this.#cacheRefreshPromise = this.#refreshBootstrapCache(this.#generation);
      drop(this.#cacheRefreshPromise);
    }
    return selected;
  }

  async #refreshBootstrapCache(generation: number): Promise<void> {
    const child = this.#child;
    try {
      // This runs after readiness, outside the first inference request's path.
      // Never store /api/status.token: it names this ephemeral local client.
      const discovered = await readJson(`${CONTROL_URL}/api/discover`, 25_000);
      const tokens = selectSigDemoMeshBootstrapTokens(discovered, {
        now: Date.now(),
        preferredNodeIds: this.#availableNodeIds,
      });
      if (
        tokens.length < 2 ||
        this.#stopped ||
        this.#child !== child ||
        generation !== this.#generation ||
        this.#mode === 'paid'
      ) {
        return;
      }
      await writeFile(
        join(this.#directory, 'bootstrap-cache.json'),
        `${JSON.stringify({ version: 1, savedAt: Date.now(), tokens })}\n`,
        { mode: 0o600 }
      );
    } catch {
      // Caching is optional; startup can always use fresh public discovery.
    } finally {
      this.#cacheRefreshPromise = undefined;
    }
  }
}
