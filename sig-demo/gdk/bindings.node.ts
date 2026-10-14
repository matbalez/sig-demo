// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-classes-per-file -- The SDK's typed ownership facades share one module. */

// Typed provider facade over the SDK's existing UniFFI namespace.
import { resolve } from 'node:path';
import { NativeObject, NativeRuntime } from './uniffi-runtime.node.ts';
import type { BindingDiagnostics } from './uniffi-runtime.node.ts';
import { uniffiSchema } from './generated/schema.std.ts';
import type {
  CompactionMessage,
  CompactionSummary,
  CompactionTemplates,
  Feature,
  GooseErrorData,
  ProviderCompletion,
  ProviderMessage,
  ProviderModelConfig,
  ProviderModelInfo,
  ProviderTool,
  StreamChunk,
} from './generated/types.std.ts';
import type { InterfaceSchema } from './schema.std.ts';

export type * from './generated/types.std.ts';
export type { BindingDiagnostics } from './uniffi-runtime.node.ts';

const schema = uniffiSchema as unknown as InterfaceSchema;

/** A typed SDK failure. Details are kept out of the default error message. */
export class GooseError extends Error {
  readonly kind: GooseErrorData['kind'] | 'Internal';
  readonly details?: string;
  readonly retryAfterMs?: number | bigint | null;
  readonly retryAfterSuffix?: string;

  constructor(data: GooseErrorData | { kind: 'Internal'; details?: string }) {
    super(`GDK ${data.kind} error.`);
    this.name = 'GooseError';
    this.kind = data.kind;
    if ('details' in data) this.details = data.details;
    if ('retryAfterMs' in data) this.retryAfterMs = data.retryAfterMs;
    if ('retryAfterSuffix' in data)
      this.retryAfterSuffix = data.retryAfterSuffix;
  }
}

export class Provider extends NativeObject {
  constructor(runtime: NativeRuntime, value: bigint) {
    super(runtime, value, 'Provider');
  }

  name(): string {
    return this.runtime.call(
      this.runtime.method(this, 'name'),
      [],
      this
    ) as string;
  }
  supportedFeatures(): ReadonlyArray<Feature> {
    return this.runtime.call(
      this.runtime.method(this, 'supported_features'),
      [],
      this
    ) as ReadonlyArray<Feature>;
  }
  listModels(signal?: AbortSignal): Promise<ReadonlyArray<ProviderModelInfo>> {
    return this.runtime.callAsync(
      this.runtime.method(this, 'list_models'),
      [],
      this,
      signal
    ) as Promise<ReadonlyArray<ProviderModelInfo>>;
  }
  contextLimit(
    model: ProviderModelConfig,
    signal?: AbortSignal
  ): Promise<bigint> {
    return this.runtime.callAsync(
      this.runtime.method(this, 'context_limit'),
      [model],
      this,
      signal
    ) as Promise<bigint>;
  }
  stream(
    model: ProviderModelConfig,
    system: string,
    messages: ReadonlyArray<ProviderMessage>,
    tools: ReadonlyArray<ProviderTool>,
    signal?: AbortSignal
  ): Promise<ProviderStream> {
    return this.runtime.callAsync(
      this.runtime.method(this, 'stream'),
      [model, system, messages, tools],
      this,
      signal
    ) as Promise<ProviderStream>;
  }
  complete(
    model: ProviderModelConfig,
    system: string,
    messages: ReadonlyArray<ProviderMessage>,
    tools: ReadonlyArray<ProviderTool>,
    signal?: AbortSignal
  ): Promise<ProviderCompletion> {
    return this.runtime.callAsync(
      this.runtime.method(this, 'complete'),
      [model, system, messages, tools],
      this,
      signal
    ) as Promise<ProviderCompletion>;
  }
  compact(
    modelName: string,
    messages: ReadonlyArray<CompactionMessage>,
    templates?: CompactionTemplates | null,
    signal?: AbortSignal
  ): Promise<CompactionSummary> {
    return this.runtime.callAsync(
      this.runtime.method(this, 'compact'),
      [modelName, messages, templates],
      this,
      signal
    ) as Promise<CompactionSummary>;
  }
}

export class ProviderStream extends NativeObject {
  #pending = false;
  constructor(runtime: NativeRuntime, value: bigint) {
    super(runtime, value, 'ProviderStream');
  }
  async nextChunk(signal?: AbortSignal): Promise<StreamChunk | null> {
    if (this.#pending)
      throw new Error('Only one GDK stream read can be pending.');
    this.#pending = true;
    try {
      return (await this.runtime.callAsync(
        this.runtime.method(this, 'next_chunk'),
        [],
        this,
        signal
      )) as StreamChunk | null;
    } finally {
      this.#pending = false;
    }
  }
}

export class GdkBindings {
  readonly #runtime: NativeRuntime;
  constructor(libraryPath: string) {
    this.#runtime = new NativeRuntime(libraryPath, schema, {
      createError: data => new GooseError(data as GooseErrorData),
      createObject: (runtime, value, name) => {
        if (name === 'Provider') return new Provider(runtime, value);
        if (name === 'ProviderStream')
          return new ProviderStream(runtime, value);
        return new NativeObject(runtime, value, name);
      },
    });
  }
  openaiProvider(apiKey: string, baseUrl: string | null = null): Provider {
    return this.#runtime.factory('openai_provider', [
      apiKey,
      baseUrl,
    ]) as Provider;
  }
  declarativeProviderFromJson(json: string): Provider {
    return this.#runtime.factory('declarative_provider_from_json', [
      json,
    ]) as Provider;
  }
  diagnostics(): BindingDiagnostics {
    return this.#runtime.diagnostics();
  }
}

// Keep each loaded SDK/callback/runtime alive for the process lifetime. Never
// unload a cdylib while its Tokio threads can still invoke a registered callback.
const loadedBindings = new Map<string, GdkBindings>();
export function loadGdk(libraryPath: string): GdkBindings {
  const absolutePath = resolve(libraryPath);
  let binding = loadedBindings.get(absolutePath);
  if (!binding) {
    binding = new GdkBindings(absolutePath);
    loadedBindings.set(absolutePath, binding);
  }
  return binding;
}
