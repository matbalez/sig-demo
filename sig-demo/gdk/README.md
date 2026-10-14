# Native Goose agent in sig demo

Sig demo embeds the published **`goose-agent` 0.1.0-alpha.12** crate in the
Electron main process. Its real `StateMachine`, `InferenceRunner`, and
`ToolOperation` manage each query. The application exposes that runtime through
**UniFFI 0.32.2**, called from TypeScript using **Koffi 3.3.3**.

## Responsibilities

Signal reads eligible text records from its own chat database and supplies the
current question, display name, recent candidate messages, and current date.
It excludes deleted/expired messages, attachments, unfinished Sig replies, and
messages outside the chat or after the question. The IPC boundary permits up to
60 candidate records within a transport byte limit.

The **native agent** selects the actual context window: up to 12 recent messages,
6,000 UTF-8 bytes including authors, with each entry bounded to 1,500 bytes.
It normalizes display names, preserves useful message tails, constructs Sig's
system/tool prompts, and seeds the state-machine conversation. Prior chat is
quoted background data; the current question is identified explicitly. Each
invocation creates an independent in-memory session. Signal remains the source
of chat history; the agent has no separate persistent memory.

```mermaid
flowchart TD
    UI[Signal chat UI] <-->|IPC: chat records and events| TS[TypeScript adapter]
    TS <-->|UniFFI via Koffi| SM[Rust goose-agent StateMachine]
    SM --> C[Native Sig context and prompt operation]
    SM --> I[Goose InferenceRunner]
    SM --> T[Goose ToolOperation]
    I <--> P[Native GDK model provider]
    P <--> M[Local mesh-llm sidecar]
    P <--> O[OpenAI Responses API]
    T <--> B[Native Brave search tool]
```

The TypeScript adapter forwards native text, status, timing, and terminal events.
It does not build model prompts, execute tools, or request model continuations.

## Native integration

- `native-agent/src/lib.rs` defines the small application UniFFI interface:
  `start_sig_agent(config, request)`, and an owned stream with `next_event`,
  `cancel`, and asynchronous `shutdown`.
- `native-agent/src/runtime.rs` registers native operations and calls the
  upstream `StateMachine::run`. Session loading and effect application keep
  conversation and tool results within that invocation.
- `native-agent/src/context.rs` owns context selection and prompt contributions.
- `native-agent/src/brave.rs` calls Brave's LLM Context endpoint directly from
  Rust with bounded results and a local credential. Goose's `ToolOperation`
  executes it. ChatGPT uses OpenAI's built-in search instead.
- `native-agent/src/compat_provider.rs` preserves the observed mesh tool-call
  aliases and text-format compatibility while retaining provider metadata.
- Native limits permit at most two searches and three model turns. Another
  model request requires a newly completed search; ordinary answers use one.
  No inference is sent as an agent-planning preflight.
- Free-mesh warming is a native warmup mode sharing the same prompts and tool
  schema. Paid mesh is connected without a synthetic inference warmup.

The mesh sidecar still owns discovery, routing, wallet state, and payments.
The native agent only calls its loopback inference endpoint. The approved
private demo keys remain in the packaged runtime configuration; mesh requests
do not receive an OpenAI key, and the Brave key is sent only to Brave.

## Bindings and build

`uniffi-runtime.node.ts` and `codec.node.ts` implement UniFFI buffers, records,
enums, opaque object handles, and Rust futures. The codec copies returned
buffers into V8-owned memory before freeing Rust memory, as required by
Electron's V8 memory cage. Each namespace validates the native contract and
interface checksums before calls are made.

`agent-bindings.node.ts` is the typed facade for `libsig_demo_agent.dylib`.
`bindgen/src/main.rs` uses official `uniffi_bindgen` metadata extraction;
`generate-types.node.mjs` generates `generated-agent/` types and ABI metadata.
These descriptors come from the actual native library.

Build with Rust 1.95.0 and Node 24.21.0:

```sh
sh sig-demo/gdk/build-native.sh
```

The script also retains the original provider-only SDK library and bindings for
development smoke checks. The app loads and packages the native agent library
under `Resources/sig-demo-gdk/libsig_demo_agent.dylib`.

The provider-types vendor patches preserve OpenAI Responses built-in search and
citations, and assemble streamed tools across paid mesh's intermediate billing
usage frames. See `native/vendor/goose-provider-types/SIG_DEMO_PATCH.md`.

## Cancellation and verification

An `AbortSignal` cancels the pending UniFFI future and signals the native agent.
The adapter awaits native `shutdown()` before disposing its stream or completing
the request. Provider switching therefore waits for native work to release its
I/O before changing the mesh process or spending policy. `Drop` provides an
abort fallback. Loaded libraries and registered callbacks remain alive for the
process lifetime.

Tests use synthetic local model responses and fake credentials. Rust checks
cover native tools and state-machine behavior; Node/Electron checks exercise
the compiled library through the actual TypeScript UniFFI bindings. No paid
inference is needed for these checks.

```sh
pnpm run demo:test
cargo +1.95.0 test --locked --manifest-path sig-demo/gdk/native-agent/Cargo.toml
pnpm run demo:agent:test:native
pnpm run demo:agent:test:electron
```

References: [GDK overview](https://goose-docs.ai/docs/gdk/),
[Goose agent state machines](https://goose-docs.ai/blog/2026/09/16/agentic-state-machines/),
[UniFFI async FFI](https://mozilla.github.io/uniffi-rs/latest/internals/async-ffi.html).
