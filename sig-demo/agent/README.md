# Sig agent helper

Type `@sig` followed by a question in any demo chat. The sender's Mac starts a
fresh local helper, and everyone in the chat sees one reply bubble under the
virtual Sig identity, updated as text streams. Each new query gets a separate
bubble. These updates use the existing encrypted direct or group messaging path.

The helper uses the real [Goose Development Kit Rust SDK](https://goose-docs.ai/docs/gdk/sdk/), pinned to `goose-sdk = 0.1.0-alpha.12` with the `uniffi` feature. It calls the SDK's OpenAI provider and consumes `ProviderStream::next_chunk`; there is no separate HTTP client or Goose agent process.

Each invocation accepts one JSON object on stdin, then EOF:

```json
{ "prompt": "What is a rainbow?", "model": "gpt-6-luna" }
```

`model` defaults to `gpt-6-luna`. Supply `OPENAI_API_KEY` privately in the child environment. Stdout contains flushed newline-delimited JSON events:

```json
{"type":"text","text":"A rainbow"}
{"type":"text","text":" forms when…"}
{"type":"done"}
```

Failures emit `{"type":"error","message":"…"}` and exit with status 1. Raw provider details, credentials, requests, reasoning output, and token usage are never printed.

The provider receives fixed concise Sig system instructions, one user text message, and an empty tools list. The helper never loads chat history, attachments, a Goose configuration, extensions, persistent memory, or a request logger. Requests disable provider response storage and select the model's lowest supported reasoning effort through the SDK. Replies have a 2,048-token limit and a two-minute overall timeout.

Build the macOS arm64 executable with Rust 1.95 before generating and packaging
the desktop app:

```sh
sh sig-demo/agent/build.sh
```

The packaging artifact is `sig-demo/agent/target/release/sig-demo-agent`; Cargo's
reusable build cache lives under ignored `.sig-demo/agent-build`.

The approved shared burner credential stays in ignored `.sig-demo/agent.env`.
The desktop packager places it in `Contents/Resources/sig-demo-agent/runtime.json`,
alongside the helper. Electron reads that private runtime resource and supplies
`OPENAI_API_KEY` to each child process. The binary and tracked source contain no
key. Friends receive the configured app and need no API setup. Each tester's
submitted question goes to OpenAI from their own Mac.

Our helper code is licensed under `AGPL-3.0-only`; the Goose SDK and other
dependencies retain their respective upstream licenses.
