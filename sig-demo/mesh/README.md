# Bundled mesh-llm sidecar

sig demo bundles the official Apple Silicon [mesh-llm 0.78.1 release](https://github.com/Mesh-LLM/mesh-llm/releases/tag/v0.78.1).
The source and redistribution license are Apache-2.0. `release.json` pins the
archive and host checksums. Download and verify it before packaging:

```sh
node scripts/fetch-sig-demo-mesh.mjs
```

The archive is cached under ignored `.sig-demo/mesh/v0.78.1/`; the app carries
its `mesh-bundle` tree at `Contents/Resources/sig-demo-mesh/`, including the native
runtime shipped upstream. No model files, wallet seeds, or mesh node keys are
shipped. The unlisted paid-mesh invite is a separate private build resource.
This milestone supports macOS arm64 only.

At startup, the Electron main process asks other current-user processes named
exactly `mesh-llm` to exit, waits briefly, and terminates any that remain. This
behavior was explicitly requested for the demo so the bundled client can use
the standard loopback API and management ports (9337 and 3131). It never runs
the mesh `stop` command or terminates other users' processes. On quit it stops
only the child it owns.

The client has an app-owned configuration, node key, join token, and caches.
Unrelated default plugins, owner attestation, local models, and analytics are disabled.
The sidecar receives no OpenAI or Brave key. Its connection is prepared speculatively
when the app starts. Fresh discovery uses the upstream `client --auto` path,
which races multiple public bootstraps rather than retrying one serially.
After joining, sig demo caches two to four eligible public bootstrap hints for
up to 24 hours. Later launches supply each hint through a separate `--join-file`
argument to use the same parallel race; stale or unavailable hints fall back to
fresh discovery. The cache never stores the ephemeral local client's invite.
The app chooses a random available free text-inference node from `/v1/models`.
An advertised model alone does not establish inference readiness. During app
startup, a synthetic GDK request warms that selected model and its native tool
schema, with a 12-second inference timeout and 15-second helper deadline. It
contains no real messages, API keys, or executable search. The app tries at most
two distinct random free hosts and retains the first responsive route. A query
shares that preparation; unavailable routes remain retryable. The messenger
window opens independently of the probe. Public hosts can still experience later
queueing or prefill delays.
An `x-mesh-target` header pins inference to that node. A missing node produces an
error; Sig can discover another for the next request. There is no automatic
fallback to ChatGPT.

## Paid inference and Wallet

The saved **mesh-llm (paid)** option joins only the private configured invitation
and selects a paid remote offer for exactly `Qwen3.6-27B-Q6_K`. It connects without
a synthetic completion. Both mesh modes use the existing GDK bridge and local
Brave tool; the app leaves payment negotiation and settlement to mesh-llm.
An invocation's planning and final-answer completions all count toward its
automatic **₿500 daily budget**, including payment fees. Selecting free mesh or
ChatGPT restores `free_only` policy. Previously submitted payments can settle.

The app automatically installs the compatible
[Lexe v0.1.0 plugin](https://github.com/Mesh-LLM/lexe-wallet/releases/tag/v0.1.0)
in the profile's isolated plugin directory, and explicitly enables payments with
Lexe as its wallet. The first wallet read or funding operation opens/provisions
the wallet without a separate phone or login. The same configuration and
`mesh/payments/` directory are reused across free/private mesh restarts; wallet
recovery state and the ledger are never packaged or checked into Git.

The Wallet pane uses the loopback management API with the owned child PID and
expected payment directory. Balance, history, invoice generation, and policy use
the same operations as the upstream wallet CLI. Invoice generation is not
automatically retried after uncertain delivery. While visible, the pane polls
every five seconds and confirms funding by matching the invoice payment hash to
a successful incoming transaction. Displayed amounts use integer base units.

The private invite is read from `sig-demo-mesh/paid.json` in a packaged app or
ignored `.sig-demo/mesh-paid.json` in development, with `inviteToken` and `model`
fields. It never goes through logged node-config, renderer IPC, command arguments,
public bootstrap caches, or source. Provider changes are serialized; generation
checks and cancellation prevent stale free warmups from reaching the paid mesh.

The selected operator processes the current question and up to 12 recent text
messages from the same chat, under a 6,000-byte history budget. Attachments,
deleted or expired messages, and unfinished replies are excluded. GDK handles
the OpenAI-compatible streaming protocol through a declarative provider with
the explicit `/v1/chat/completions` path. A bounded GDK planning request selects
the local Brave tool through native function calls, with a validated JSON decision
fallback for text models that do not support them. Only the local Rust helper
calls Brave; the chosen mesh node receives
bounded public search excerpts and source links for the final answer.
