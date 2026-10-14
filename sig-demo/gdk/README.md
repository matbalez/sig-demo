# Native GDK in sig demo

Sig demo loads **Goose Development Kit 0.1.0-alpha.12** into the Electron main
process. The SDK itself builds `libgoose_sdk.dylib` and exports its existing
**UniFFI 0.32.2** interface. There is no agent helper executable, subprocess
protocol, or application-specific Rust API.

`bindings.node.ts` calls that interface through **Koffi 3.3.3**, a generic Node
FFI library. Koffi provides the native calling mechanism; the checked-in
TypeScript code implements UniFFI buffers, records, enums, handles, and futures.
The agent's TypeScript runtime uses native GDK providers and streams directly.

## Source and generated interface

- `native/Cargo.toml` pins the real SDK dependency. `build-native.sh` builds the
  SDK package's existing `cdylib`, rather than defining new Rust exports.
- `native/vendor/goose-provider-types` retains the small formatter patch for
  OpenAI Responses built-in web search and citations. Its notice describes the
  patch; native GDK owns provider requests and response parsing.
- `bindgen/src/main.rs` uses official `uniffi_bindgen` library metadata extraction
  to read the compiled SDK's interface. `generated/schema.json` contains the
  exact exported C symbols, interface checksums, fields, variants, and defaults.
- `generate-types.node.mjs` emits `generated/types.std.ts` and
  `generated/schema.std.ts` from that metadata. They are generated files, not a
  parallel handwritten SDK API.
- `codec.node.ts` implements UniFFI's big-endian wire representation.
- `bindings.node.ts` validates the UniFFI contract and every interface checksum
  before constructing a provider. It exposes synchronous provider factories,
  `Provider.stream`, `complete`, model metadata, compaction, and
  `ProviderStream.nextChunk`.
- `index.ts` is the public import for the TypeScript agent runtime.

The generated schema includes the SDK's full metadata. The public object
facades currently expose the provider and stream methods used by sig demo; SDK
callback interfaces and its independent decision API are not application APIs.

## Build and regenerate

On Apple Silicon macOS, with the repository's Node dependencies installed and
Rust 1.95.0 available:

```sh
sh sig-demo/gdk/build-native.sh
```

This builds the pinned SDK, copies the native library to
`sig-demo/gdk/native/target/release/libgoose_sdk.dylib`, creates an ignored
official Python binding reference in `.sig-demo/gdk-uniffi-reference`, extracts
metadata, and regenerates TypeScript types. The packaged app includes the same
library under `Resources/sig-demo-gdk/`. Native binaries and build caches are
ignored; the source, lockfiles, metadata, and generated TypeScript are committed.

To regenerate only the TypeScript interface from an already-built library:

```sh
cargo +1.95.0 run --locked \
  --manifest-path sig-demo/gdk/bindgen/Cargo.toml \
  --target-dir .sig-demo/gdk-bindgen-build -- \
  sig-demo/gdk/native/target/release/libgoose_sdk.dylib \
  sig-demo/gdk/generated/schema.json
node sig-demo/gdk/generate-types.node.mjs
```

The codec checks can run without a native library or network:

```sh
node --experimental-strip-types --test sig-demo/gdk/codec_test.node.mjs
```

The application test suite additionally checks agent behavior with mock bindings;
native Node and Electron smoke tests exercise the actual dylib against local
mock HTTP endpoints, including cancellation and built-in OpenAI search.

The opt-in native smoke needs the built library above and Node 24 or the
repository's bundled Electron. Run both from the repository root:

```sh
node sig-demo/gdk/native-smoke.node.mjs
ELECTRON_RUN_AS_NODE=1 \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  sig-demo/gdk/native-smoke.node.mjs
```

The script can also run from another working directory; its default library is
resolved relative to its own file. Pass a library path as its first argument to
check a packaged copy. It uses only fake keys and a temporary localhost HTTP
server. It never launches mesh-llm, opens an app profile, or accesses a wallet.
It checks native streaming and completion, JavaScript responsiveness, tool
argument assembly and signed metadata replay, cancellation closing sockets,
the OpenAI Responses search/citation patch, and zero outstanding native objects,
futures, or polls after cleanup. It also verifies ambient OpenAI credentials
are absent from mesh requests. Running under Electron catches its prohibition
on external ArrayBuffers; returned Rust buffers use a copying decode instead.

## Ownership and cancellation

Arguments use the SDK's UniFFI record types: message content and stream chunks
have their original variant names in a `kind` discriminator. Field names are
camelCase. Optional values accept `null` or omission. A `u64` input accepts a
safe integer or `bigint`; decoded `u64` values are `bigint`.

Rust owns lowered argument buffers and cloned object handles once a scaffold
call starts. Returned buffers are copied and freed exactly once. Each provider
and stream owns a native handle and has an idempotent `dispose()` method; a
finalizer is a fallback rather than the normal cleanup path. Async calls clone
their receiver handle, so disposing the JavaScript owner does not invalidate a
pending native call.

Async calls poll real UniFFI Rust futures through a long-lived registered
continuation. Rust thread callbacks resolve JavaScript promises; they do not
block or recursively poll the Electron main thread. `AbortSignal` cancellation
cancels and frees the pending future. GDK's `AbortOnDrop` then aborts its spawned
Tokio task. A shared Node timer keeps the event loop alive only while native
futures are pending and is cleared when the last future is freed. The agent also
disposes the native stream in `finally`, releasing the response stream after
cancellation.

The library, Tokio runtime, and registered callback stay loaded for the process
lifetime. Late wake callbacks from cancelled polls are safely ignored. The
binding's `diagnostics()` reports active future, object, and pending poll counts
for lifecycle tests. Native errors expose a typed `GooseError.kind`; their
raw details are not included in the default error message.

References: [GDK SDK](https://goose-docs.ai/docs/gdk/sdk/),
[UniFFI library metadata generation](https://mozilla.github.io/uniffi-rs/latest/tutorial/foreign_language_bindings.html),
[UniFFI async FFI](https://mozilla.github.io/uniffi-rs/latest/internals/async-ffi.html),
[Koffi callbacks](https://koffi.dev/callbacks).
