// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-classes-per-file -- The native agent stream and its loader share one facade. */

// This facade only marshals the native Goose agent API. Its state machine,
// inference continuations and Brave tool execution all remain in Rust.
import { resolve } from 'node:path';
import { NativeObject, NativeRuntime } from './uniffi-runtime.node.ts';
import type { BindingDiagnostics } from './uniffi-runtime.node.ts';
import { uniffiSchema } from './generated-agent/schema.std.ts';
import type {
  SigAgentConfig,
  SigAgentErrorData,
  SigAgentEvent,
  SigAgentRequest,
} from './generated-agent/types.std.ts';
import type { InterfaceSchema } from './schema.std.ts';

export type * from './generated-agent/types.std.ts';

const schema = uniffiSchema as unknown as InterfaceSchema;

/** Native diagnostics are kept out of the default, user-facing error message. */
export class SigAgentError extends Error {
  readonly kind: SigAgentErrorData['kind'] | 'Internal';
  readonly details?: string;

  constructor(
    data: SigAgentErrorData | { kind: 'Internal'; details?: string }
  ) {
    super(`GDK agent ${data.kind} error.`);
    this.name = 'SigAgentError';
    this.kind = data.kind;
    if ('details' in data) this.details = data.details;
  }
}

export class SigAgentStream extends NativeObject {
  #pending = false;

  constructor(runtime: NativeRuntime, value: bigint) {
    super(runtime, value, 'SigAgentStream');
  }

  async nextEvent(signal?: AbortSignal): Promise<SigAgentEvent | null> {
    if (this.#pending)
      throw new Error('Only one native agent stream read can be pending.');
    this.#pending = true;
    try {
      return (await this.runtime.callAsync(
        this.runtime.method(this, 'next_event'),
        [],
        this,
        signal
      )) as SigAgentEvent | null;
    } finally {
      this.#pending = false;
    }
  }

  cancel(): void {
    this.runtime.call(this.runtime.method(this, 'cancel'), [], this);
  }

  async shutdown(): Promise<void> {
    // Drain the native task before the main process changes mesh policy or
    // sidecar ports. Cleanup must finish even when the request was cancelled.
    await this.runtime.callAsync(
      this.runtime.method(this, 'shutdown'),
      [],
      this
    );
  }
}

/** One account/chat conversation, retained by the native Goose runtime. */
export class SigAgentSession extends NativeObject {
  constructor(runtime: NativeRuntime, value: bigint) {
    super(runtime, value, 'SigAgentSession');
  }

  run(
    config: SigAgentConfig,
    request: SigAgentRequest,
    signal?: AbortSignal
  ): Promise<SigAgentStream> {
    return this.runtime.callAsync(
      this.runtime.method(this, 'run'),
      [config, request],
      this,
      signal
    ) as Promise<SigAgentStream>;
  }
}

export class SigAgentBindings {
  readonly #runtime: NativeRuntime;

  constructor(libraryPath: string) {
    this.#runtime = new NativeRuntime(libraryPath, schema, {
      createError: data => new SigAgentError(data as SigAgentErrorData),
      createObject: (runtime, value, name) => {
        if (name === 'SigAgentStream')
          return new SigAgentStream(runtime, value);
        if (name === 'SigAgentSession')
          return new SigAgentSession(runtime, value);
        return new NativeObject(runtime, value, name);
      },
    });
  }

  createSession(accountId: string, chatId: string): SigAgentSession {
    return this.#runtime.factory('create_sig_agent_session', [
      accountId,
      chatId,
    ]) as SigAgentSession;
  }

  start(
    config: SigAgentConfig,
    request: SigAgentRequest,
    signal?: AbortSignal
  ): Promise<SigAgentStream> {
    return this.#runtime.factoryAsync(
      'start_sig_agent',
      [config, request],
      signal
    ) as Promise<SigAgentStream>;
  }

  diagnostics(): BindingDiagnostics {
    return this.#runtime.diagnostics();
  }
}

// Rust worker threads and UniFFI callbacks outlive individual requests. Keep
// their library and callback registration alive for the process lifetime.
const loadedBindings = new Map<string, SigAgentBindings>();
export function loadSigAgent(libraryPath: string): SigAgentBindings {
  const absolutePath = resolve(libraryPath);
  let binding = loadedBindings.get(absolutePath);
  if (!binding) {
    binding = new SigAgentBindings(absolutePath);
    loadedBindings.set(absolutePath, binding);
  }
  return binding;
}
