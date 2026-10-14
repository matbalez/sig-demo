// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-classes-per-file -- UniFFI runtime and its ownership facades share one module. */

// The SDK's existing UniFFI C ABI is loaded in the Electron main process.
// Provider/message/tool logic lives in GDK; this layer only implements UniFFI's
// generated wire types, RustBuffer ownership, object handles, and Rust futures.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import * as koffi from 'koffi';
import { WireCodec } from './codec.node.ts';
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
import type {
  CallableSchema,
  FfiSchema,
  InterfaceSchema,
  ObjectSchema,
  WireType,
} from './schema.std.ts';

export type * from './generated/types.std.ts';

const schema = uniffiSchema as unknown as InterfaceSchema;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
type NativeFunction = (...args: Array<unknown>) => unknown;
type NativeBuffer = {
  capacity: number | bigint;
  len: number | bigint;
  data: unknown;
};
type NativeStatus = { code: number; errorBuf: NativeBuffer };
type Cleanup = () => void;

// Explicit distinct names avoid anonymous struct/prototype pointer-name clashes
// in Koffi's type cache. A module-local suffix also permits isolated test imports.
const ffiPrefix = `SigGdk_${randomUUID().replaceAll('-', '')}`;
const rustBufferType = koffi.struct(`${ffiPrefix}_RustBuffer`, {
  capacity: 'uint64_t',
  len: 'uint64_t',
  data: 'void *',
});
const foreignBytesType = koffi.struct(`${ffiPrefix}_ForeignBytes`, {
  len: 'int32_t',
  data: 'void *',
});
const statusType = koffi.struct(`${ffiPrefix}_RustCallStatus`, {
  code: 'int8_t',
  errorBuf: rustBufferType,
});
const continuationType = koffi.proto(`${ffiPrefix}_Continuation`, 'void', [
  'uint64_t',
  'uint8_t',
]);
const continuationPointerType = koffi.pointer(continuationType);

const abortError = (): Error => {
  const error = new Error('The GDK request was cancelled.');
  error.name = 'AbortError';
  return error;
};
const defaultStatus = (): NativeStatus => ({
  code: 0,
  errorBuf: { capacity: 0, len: 0, data: null },
});
const handle = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return BigInt(value);
  throw new TypeError('Invalid native GDK handle.');
};

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

export type BindingDiagnostics = Readonly<{
  activeFutures: number;
  activeObjects: number;
  pendingPolls: number;
}>;

class NativeRuntime {
  readonly #library: koffi.LibraryHandle;
  readonly #functions = new Map<string, NativeFunction>();
  readonly #objects = new Map(
    schema.objects.map(object => [object.name, object])
  );
  readonly #polls = new Map<bigint, (result: number) => void>();
  readonly #continuation: bigint;
  readonly #returnCodec: WireCodec;
  #nextPoll = 1n;
  #activeFutures = 0;
  #activeObjects = 0;
  #futureKeepAlive: ReturnType<typeof setInterval> | undefined;

  constructor(libraryPath: string) {
    this.#library = koffi.load(libraryPath);
    const contract = this.#library.func(
      schema.contractSymbol,
      'uint32_t',
      []
    )();
    if (contract !== schema.contractVersion) {
      throw new Error(
        'The bundled GDK UniFFI contract does not match its TypeScript bindings.'
      );
    }
    for (const checksum of schema.checksums) {
      const actual = this.#library.func(checksum.symbol, 'uint16_t', [])();
      if (actual !== checksum.value) {
        throw new Error(
          'The bundled GDK interface checksum does not match its TypeScript bindings.'
        );
      }
    }
    this.#returnCodec = new WireCodec(schema, {
      lowerObject: () => {
        throw new TypeError('Cannot lower a native object while decoding.');
      },
      liftObject: (value, name) => this.#liftObject(value, name),
    });
    // Rust wakes these continuations from Tokio threads after poll returns.
    // A registered callback remains valid for the lifetime of the loaded SDK;
    // resolving a JS promise here avoids recursive polling or blocking waits.
    this.#continuation = koffi.register(
      (data: number | bigint, result: number) => {
        const token = handle(data);
        const resolvePoll = this.#polls.get(token);
        if (!resolvePoll) return; // An already-cancelled poll may wake late.
        this.#polls.delete(token);
        resolvePoll(result);
      },
      continuationPointerType
    );
  }

  diagnostics(): BindingDiagnostics {
    return {
      activeFutures: this.#activeFutures,
      activeObjects: this.#activeObjects,
      pendingPolls: this.#polls.size,
    };
  }

  #ffiType(name: string): string | koffi.TypeObject {
    if (name === 'rust_buffer') return rustBufferType;
    if (name === 'foreign_bytes' || name === 'foreignbytes')
      return foreignBytesType;
    if (name === 'void') return 'void';
    if (/^(u?int)(8|16|32|64)$/.test(name)) return `${name}_t`;
    if (name === 'float32') return 'float';
    if (name === 'float64') return 'double';
    throw new TypeError(`Unsupported UniFFI ABI type: ${name}.`);
  }

  #ffi(definition: FfiSchema): NativeFunction {
    const cached = this.#functions.get(definition.symbol);
    if (cached) return cached;
    const args: Array<
      string | koffi.TypeObject | ReturnType<typeof koffi.out>
    > = definition.arguments.map(type => this.#ffiType(type));
    if (definition.status) args.push(koffi.out(koffi.pointer(statusType)));
    const fn = this.#library.func(
      definition.symbol,
      this.#ffiType(definition.return),
      args
    );
    this.#functions.set(definition.symbol, fn);
    return fn;
  }

  #checkedCall(
    definition: FfiSchema,
    args: ReadonlyArray<unknown>,
    errorType: string | null = null
  ): unknown {
    const fn = this.#ffi(definition);
    if (!definition.status) return fn(...args);
    const status = defaultStatus();
    const value = fn(...args, status);
    if (status.code === 0) return value;
    const bytes = this.#consumeBuffer(status.errorBuf);
    if (status.code === 1 && errorType) {
      throw new GooseError(
        this.#returnCodec.decode(
          { kind: 'enum', name: errorType },
          bytes
        ) as GooseErrorData
      );
    }
    throw new GooseError({ kind: 'Internal', details: bytes.toString('utf8') });
  }

  #newBuffer(bytes: Buffer<ArrayBuffer>): NativeBuffer {
    return this.#checkedCall(schema.buffers.fromBytes, [
      { len: bytes.length, data: bytes },
    ]) as NativeBuffer;
  }

  #freeBuffer(buffer: NativeBuffer): void {
    this.#checkedCall(schema.buffers.free, [buffer]);
  }

  #consumeBuffer(buffer: NativeBuffer): Buffer<ArrayBuffer> {
    try {
      const length = Number(buffer.len);
      const capacity = Number(buffer.capacity);
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_BUFFER_BYTES ||
        capacity < length
      ) {
        throw new TypeError('Invalid GDK RustBuffer.');
      }
      if (length === 0) return Buffer.alloc(0);
      if (!buffer.data) throw new TypeError('Invalid GDK RustBuffer pointer.');
      // Decode copies into V8-owned memory before Rust frees its buffer.
      // Electron's V8 memory cage forbids external ArrayBuffer views.
      return Buffer.from(
        koffi.decode(buffer.data, 'uint8_t', length) as Uint8Array<ArrayBuffer>
      );
    } finally {
      this.#freeBuffer(buffer);
    }
  }

  #objectDefinition(name: string): ObjectSchema {
    const definition = this.#objects.get(name);
    if (!definition) throw new TypeError('Unknown native GDK object type.');
    return definition;
  }

  #cloneObject(object: unknown, name: string): bigint {
    if (
      !(object instanceof NativeObject) ||
      object.runtime !== this ||
      object.nativeName !== name
    ) {
      throw new TypeError('Invalid native GDK object argument.');
    }
    return handle(
      this.#checkedCall(this.#objectDefinition(name).clone, [
        object.borrowHandle(),
      ])
    );
  }

  #liftObject(value: bigint, name: string): NativeObject {
    if (value === 0n) throw new TypeError('Invalid native GDK object result.');
    this.#activeObjects += 1;
    if (name === 'Provider') return new Provider(this, value);
    if (name === 'ProviderStream') return new ProviderStream(this, value);
    return new NativeObject(this, value, name);
  }

  freeObject(value: bigint, name: string): void {
    try {
      this.#checkedCall(this.#objectDefinition(name).free, [value]);
    } finally {
      this.#activeObjects -= 1;
    }
  }

  #lowerArguments(
    definition: CallableSchema,
    values: ReadonlyArray<unknown>,
    object?: NativeObject
  ): { args: Array<unknown>; cleanup: Array<Cleanup> } {
    const cleanup: Array<Cleanup> = [];
    const args: Array<unknown> = [];
    const codec = new WireCodec(schema, {
      lowerObject: (value, name) => {
        const clone = this.#cloneObject(value, name);
        cleanup.push(() => {
          this.#checkedCall(this.#objectDefinition(name).free, [clone]);
        });
        return clone;
      },
      liftObject: () => {
        throw new TypeError('Cannot lift a native object while encoding.');
      },
    });
    try {
      if (object) {
        const clone = this.#cloneObject(object, object.nativeName);
        args.push(clone);
        cleanup.push(() => {
          this.#checkedCall(this.#objectDefinition(object.nativeName).free, [
            clone,
          ]);
        });
      }
      for (let index = 0; index < definition.arguments.length; index += 1) {
        const argument = definition.arguments[index];
        if (!argument) throw new TypeError('Missing GDK argument metadata.');
        const value =
          values[index] === undefined && Object.hasOwn(argument, 'default')
            ? argument.default
            : values[index];
        const ffiType = definition.ffi.arguments[index + (object ? 1 : 0)];
        if (ffiType === 'rust_buffer') {
          const buffer = this.#newBuffer(codec.encode(argument.type, value));
          args.push(buffer);
          cleanup.push(() => this.#freeBuffer(buffer));
        } else if (argument.type.kind === 'object') {
          args.push(codec.objects.lowerObject(value, argument.type.name ?? ''));
        } else {
          // The codec validates ranges without handing temporary JS memory to C.
          codec.encode(argument.type, value);
          args.push(value);
        }
      }
      return { args, cleanup };
    } catch (error) {
      for (const release of cleanup.reverse()) release();
      throw error;
    }
  }

  #liftResult(
    type: WireType | null,
    ffiType: string,
    result: unknown
  ): unknown {
    if (!type) return undefined;
    if (ffiType === 'rust_buffer')
      return this.#returnCodec.decode(
        type,
        this.#consumeBuffer(result as NativeBuffer)
      );
    if (type.kind === 'object')
      return this.#liftObject(handle(result), type.name ?? '');
    if (type.kind === 'uint64' || type.kind === 'int64') return handle(result);
    if (type.kind === 'boolean') return Boolean(result);
    return result;
  }

  call(
    definition: CallableSchema,
    values: ReadonlyArray<unknown>,
    object?: NativeObject
  ): unknown {
    this.#ffi(definition.ffi); // Resolve/validate the C signature before allocating arguments.
    const lowered = this.#lowerArguments(definition, values, object);
    // Once the scaffold is entered, it owns all lowered RustBuffers and clones,
    // including on SDK errors. Cleanup is only for failure before that boundary.
    const result = this.#checkedCall(
      definition.ffi,
      lowered.args,
      definition.error
    );
    return this.#liftResult(definition.return, definition.ffi.return, result);
  }

  async callAsync(
    definition: CallableSchema,
    values: ReadonlyArray<unknown>,
    object?: NativeObject,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    this.#ffi(definition.ffi);
    const lowered = this.#lowerArguments(definition, values, object);
    const future = handle(
      this.#checkedCall(definition.ffi, lowered.args, definition.error)
    );
    return this.#awaitFuture(future, definition, signal);
  }

  async #awaitFuture(
    future: bigint,
    definition: CallableSchema,
    signal?: AbortSignal
  ): Promise<unknown> {
    const flavor = schema.futures[definition.futureFlavor];
    if (!flavor) throw new TypeError('Unsupported native GDK future result.');
    const poll = this.#library.func(flavor.poll, 'void', [
      'uint64_t',
      continuationPointerType,
      'uint64_t',
    ]);
    const cancel = this.#library.func(flavor.cancel, 'void', ['uint64_t']);
    const free = this.#library.func(flavor.free, 'void', ['uint64_t']);
    let token: bigint | undefined;
    let cancelled = signal?.aborted ?? false;
    let released = false;
    this.#activeFutures += 1;
    if (this.#activeFutures === 1) {
      // Rust/Tokio work does not itself ref Node's event loop. Keep it alive
      // while a native promise is pending, including in standalone Node tools.
      this.#futureKeepAlive = setInterval(() => undefined, 2_147_483_647);
    }
    const onAbort = (): void => {
      if (released || cancelled) return;
      cancelled = true;
      cancel(future);
      // UniFFI cancellation normally wakes the registered callback; resolving
      // here as well guarantees prompt free even if that callback is queued.
      if (token !== undefined) {
        const wake = this.#polls.get(token);
        this.#polls.delete(token);
        wake?.(-1);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (cancelled) {
        cancel(future);
        throw abortError();
      }
      for (;;) {
        token = this.#nextPoll;
        this.#nextPoll += 1n;
        const currentToken = token;
        // Each native poll depends on the previous wake; parallel polling is invalid.
        // eslint-disable-next-line no-await-in-loop
        const result = await new Promise<number>((resolvePoll, rejectPoll) => {
          this.#polls.set(currentToken, resolvePoll);
          try {
            poll(future, this.#continuation, currentToken);
          } catch (error) {
            this.#polls.delete(currentToken);
            rejectPoll(error);
          }
        });
        token = undefined;
        if (cancelled || signal?.aborted) throw abortError();
        if (result === 0) break; // READY
        if (result !== 1) throw new GooseError({ kind: 'Internal' }); // WAKE => repoll
      }
      const result = this.#checkedCall(
        flavor.complete,
        [future],
        definition.error
      );
      return this.#liftResult(
        definition.return,
        flavor.complete.return,
        result
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (token !== undefined) this.#polls.delete(token);
      released = true;
      // free drops the Rust future and SDK AbortOnDrop aborts underlying Tokio
      // work. cancel alone only wakes UniFFI's scheduler and does not drop it.
      try {
        free(future);
      } finally {
        this.#activeFutures -= 1;
        if (this.#activeFutures === 0) {
          clearInterval(this.#futureKeepAlive);
          this.#futureKeepAlive = undefined;
        }
      }
    }
  }

  method(object: NativeObject, name: string): CallableSchema {
    const method = this.#objectDefinition(object.nativeName).methods.find(
      item => item.name === name
    );
    if (!method) throw new TypeError('Unknown native GDK method.');
    return method;
  }

  factory(name: string, args: ReadonlyArray<unknown>): unknown {
    const definition = schema.functions.find(item => item.name === name);
    if (!definition || definition.async)
      throw new TypeError('Unknown synchronous GDK factory.');
    return this.call(definition, args);
  }
}

const objectFinalizer = new FinalizationRegistry<{
  runtime: NativeRuntime;
  value: bigint;
  name: string;
}>(owned => {
  try {
    owned.runtime.freeObject(owned.value, owned.name);
  } catch {
    /* No throwing from GC cleanup. */
  }
});

class NativeObject {
  #value: bigint | undefined;
  readonly runtime: NativeRuntime;
  readonly nativeName: string;
  constructor(runtime: NativeRuntime, value: bigint, nativeName: string) {
    this.runtime = runtime;
    this.nativeName = nativeName;
    this.#value = value;
    objectFinalizer.register(this, { runtime, value, name: nativeName }, this);
  }

  borrowHandle(): bigint {
    if (this.#value === undefined)
      throw new Error('The native GDK object has been disposed.');
    return this.#value;
  }

  dispose(): void {
    if (this.#value === undefined) return;
    const value = this.#value;
    this.#value = undefined;
    objectFinalizer.unregister(this);
    this.runtime.freeObject(value, this.nativeName);
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
    this.#runtime = new NativeRuntime(libraryPath);
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
