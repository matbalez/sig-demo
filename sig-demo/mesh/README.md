# Bundled mesh-llm sidecar

sig demo bundles the official Apple Silicon [mesh-llm 0.78.1 release](https://github.com/Mesh-LLM/mesh-llm/releases/tag/v0.78.1).
The source and redistribution license are Apache-2.0. `release.json` pins the
archive and host checksums. Download and verify it before packaging:

```sh
node scripts/fetch-sig-demo-mesh.mjs
```

The archive is cached under ignored `.sig-demo/mesh/v0.78.1/`; the app carries
its `mesh-bundle` tree at `Contents/Resources/sig-demo-mesh/`, including the native
runtime shipped upstream. No model files, invitation tokens, or mesh node keys
are shipped. This milestone supports macOS arm64 only.

At startup, the Electron main process asks other current-user processes named
exactly `mesh-llm` to exit, waits briefly, and terminates any that remain. This
behavior was explicitly requested for the demo so the bundled client can use
the standard loopback API and management ports (9337 and 3131). It never runs
the mesh `stop` command or terminates other users' processes. On quit it stops
only the child it owns.

The client has an app-owned configuration, node key, join token, and caches.
Default plugins, owner attestation, local models, and analytics are disabled.
The sidecar receives no OpenAI or Brave key. Its connection is prepared speculatively
when the app starts. Fresh discovery uses the upstream `client --auto` path,
which races multiple public bootstraps rather than retrying one serially.
After joining, sig demo caches two to four eligible public bootstrap hints for
up to 24 hours. Later launches supply each hint through a separate `--join-file`
argument to use the same parallel race; stale or unavailable hints fall back to
fresh discovery. The cache never stores the ephemeral local client's invite.
The app chooses a random available free text-inference node from `/v1/models`.
An `x-mesh-target` header pins inference to that node. A missing node produces an
error; Sig can discover another for the next request. There is no automatic
fallback to ChatGPT and no paid-node funding.

The selected operator processes the current question and up to 12 recent text
messages from the same chat, under a 6,000-byte history budget. Attachments,
deleted or expired messages, and unfinished replies are excluded. GDK handles
the OpenAI-compatible streaming protocol through a declarative provider with
the explicit `/v1/chat/completions` path. A bounded GDK planning request selects
the local Brave tool through native function calls, with a validated JSON decision
fallback for text models that do not support them. Only the local Rust helper
calls Brave; the chosen mesh node receives
bounded public search excerpts and source links for the final answer.
