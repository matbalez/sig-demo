# Sig agent helper

Type `@sig` followed by a question in any demo chat. The sender's Mac starts a
fresh local helper, and everyone in the chat sees one reply bubble under the
virtual Sig identity, updated as text streams. Each new query gets a separate
bubble. These updates use the existing encrypted direct or group messaging path.

The helper uses the real [Goose Development Kit Rust SDK](https://goose-docs.ai/docs/gdk/sdk/), pinned to `goose-sdk = 0.1.0-alpha.12` with the `uniffi` feature. All model requests use GDK's provider completion and streaming APIs. For the bundled mesh-llm sidecar, the SDK's documented declarative provider factory uses the OpenAI-compatible Chat Completions API with an explicit `v1/chat/completions` path and no authentication. For ChatGPT, the OpenAI provider factory preserves the existing native OpenAI configuration.

Each invocation accepts one JSON object on stdin, then EOF:

```json
{
  "prompt": "What is a rainbow?",
  "author": "Alice",
  "currentDate": "2026-10-14",
  "history": [
    { "role": "user", "author": "Bob", "text": "We were discussing light." },
    { "role": "assistant", "author": "Sig", "text": "Light can be refracted." }
  ],
  "provider": "mesh-llm",
  "model": "model-advertised-by-selected-node",
  "baseUrl": "http://127.0.0.1:49152/v1",
  "targetNodeId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Electron starts its own mesh sidecar, discovers an inference node and model, and supplies them on each request. `baseUrl` must be `http://127.0.0.1:<port>/v1`; arbitrary URLs, query parameters, credentials and other paths are rejected. The optional `targetNodeId` is exactly 64 hexadecimal characters and becomes the `x-mesh-target` request header, pinning the chosen remote node. Mesh requests do not read `OPENAI_API_KEY` and send no authorization header.

For the ChatGPT setting, the request is:

```json
{ "prompt": "What is a rainbow?", "provider": "chatgpt", "model": "gpt-6-luna" }
```

Supply `OPENAI_API_KEY` privately in the ChatGPT child environment. For compatibility with the previous helper protocol, an omitted `provider` means `chatgpt` and an omitted ChatGPT `model` defaults to `gpt-6-luna`. The app selects mesh-llm by default. ChatGPT rejects `baseUrl` and `targetNodeId` overrides. Stdout contains flushed newline-delimited JSON events:

```json
{"type":"text","text":"A rainbow"}
{"type":"text","text":" forms when…"}
{"type":"done"}
```

Failures emit `{"type":"error","message":"…"}` and exit with status 1. Raw provider details, credentials, requests, reasoning output, and token usage are never printed.

The desktop reads a fresh snapshot of at most 12 completed text messages before the current question, from the same chat. Recent human messages and completed Sig replies are included. The history budget is 6,000 UTF-8 bytes including author labels (roughly 2,000 tokens); each history message is capped at 1,500 bytes and each author label at 96 bytes. Long messages retain their most recent text with a visible truncation marker. Deleted, erased, expired, view-once, system, unfinished, and failed-response messages are excluded. The current question is separate from this history budget.

The provider receives fixed concise Sig system instructions and a user message containing structured `recentHistory` and `currentRequest` fields. The system explicitly instructs Sig to answer `currentRequest`, using quoted history only to resolve references and follow-ups. A single structured user message also works with models that require strict user/assistant turn alternation in group chats. Omitted `history` is empty and omitted `author` is `Current user`, preserving earlier callers. Electron supplies the current UTC date for time-sensitive searches.

The app owns its bounded chat-history selection and small tool loop; it does not start GDK's full agent state machine or a persistent SDK session. The helper never loads attachments, a Goose configuration, general extensions, persistent memory, or a request logger. ChatGPT requests disable provider response storage and select the model's lowest supported reasoning effort through the SDK; mesh requests use the compatible payload without those OpenAI-specific fields. Replies have a 2,048-token limit and a two-minute overall timeout.

## Local Brave search

For **mesh-llm**, the only local tool is `brave_web_search`. Its model-visible arguments contain a search query and an optional freshness filter, never credentials. The local Rust helper calls the fixed HTTPS [Brave LLM Context endpoint](https://api-dashboard.search.brave.com/documentation/services/llm-context), which returns extracted page content and sources without a separate crawler. A call considers at most five results/URLs, asks Brave for a 2,048-token context budget, and further caps returned tool data at 6,000 UTF-8 bytes. At most two Brave searches run per question. Source excerpts are treated as quoted data and answers include direct source URLs.

The official [Brave MCP server](https://github.com/brave/brave-search-mcp-server) provides the established Goose integration. This SDK-based helper uses the tool contract locally instead of adding another Node/MCP process to the app. Mesh uses GDK `ProviderTool`, assistant `ToolRequest`, and matching `ToolResult` messages. Public mesh models have inconsistent native function-call support; when a model rejects or ignores the native tool protocol, mesh uses a small validated JSON search decision through the same GDK provider. Both paths keep tool planning out of the chat and then stream the final answer through GDK. This adds a short planning request for mesh when Brave is configured; final answers still appear in one streamed Sig bubble.

For **ChatGPT**, a single GDK streaming request enables OpenAI's built-in [`web_search` tool](https://developers.openai.com/api/docs/guides/tools-web-search) in the Responses API, with at most two built-in tool calls. Search runs inside OpenAI's inference service. The local Brave tool and credential are absent from this path. The pinned GDK alpha12 formatter does not yet support built-in search output, so the helper vendors a narrowly patched formatter crate under `vendor/`: it enables the native tool, accepts built-in search events, and retains citation URLs as chat-visible source links. Inference still runs through the real GDK SDK.

The shared Brave key stays in ignored `.sig-demo/brave.env` during development and in the private bundle's `sig-demo-agent/runtime.json` as `braveApiKey`. Electron passes `BRAVE_SEARCH_API_KEY` only to the local Rust helper. Brave receives the search query; the inference provider receives the returned public excerpts and links. Neither the tool schema nor model requests include the key. Standard Brave API query retention is governed by its [privacy notice](https://api-dashboard.search.brave.com/app/documentation/general/privacy-policy); this does not promise zero data retention.

Build the macOS arm64 executable with Rust 1.95 before generating and packaging
the desktop app:

```sh
sh sig-demo/agent/build.sh
```

The packaging artifact is `sig-demo/agent/target/release/sig-demo-agent`; Cargo's
reusable build cache lives under ignored `.sig-demo/agent-build`.

The approved shared OpenAI burner credential stays in ignored `.sig-demo/agent.env`.
The desktop packager places it in `Contents/Resources/sig-demo-agent/runtime.json`,
alongside the helper. Electron reads that private runtime resource and supplies
`OPENAI_API_KEY` only to ChatGPT child processes. The Brave key is included in the
same private runtime resource and passed only to mesh's local search tool. The executable
and tracked source contain no keys. Friends receive the configured app and need no API setup. Each tester's
question and bounded chat context go to their selected provider from their own Mac.

Our helper code is licensed under `AGPL-3.0-only`; the Goose SDK and other
dependencies retain their respective upstream licenses.
