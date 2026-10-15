# Bundled mesh-llm sidecar

For an incident snapshot on a development Mac, leave the app open on the failing
provider/node and run `sh scripts/collect-sig-demo-diagnostics.sh` before retrying
or restarting. It saves a filtered JSON report under ignored
`.sig-demo/diagnostics/`, including process ages, peer freshness, routing counters,
and recent agent error references. It makes no inference or wallet requests and
does not restart processes. The active network-diagnostics endpoint is excluded.
No raw API responses, chat text, credentials, invitations, invoices, or network
addresses are saved. This captures available evidence; it cannot reconstruct
underlying paid error details already discarded by mesh-llm 0.78.1.

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

## Model and node selection

General settings shows a model/node selector for either mesh provider. Automatic
retains randomized free discovery and uses the configured default paid target.
An explicit selection pins both the model and full node identity. Free and paid
selections are saved independently. Free warmup honors an explicit pin and does
not try another node; paid selection never submits synthetic inference.

The selector reads `/v1/models` advertisements and optional `/api/status` peer
metadata. Models, full node identities, advertised prices, capabilities, context
limits, last-seen information, and available host/hardware/version/latency details
are displayed without exposing private invitations. Short peer IDs are matched
to full identities only when their prefixes are unambiguous. Availability means
currently advertised, not a paid inference health check. Refresh never submits
an inference request or creates a Lightning invoice.

Failed Sig replies include a diagnostic category, the provider/model and short
target node identity, and the phase that failed. An HTTP status appears only
when retained by the native provider. Recognized payment and routing reasons
use fixed labels; arbitrary response bodies and private invitations are not
displayed. Startup and configuration errors remain separate from an empty
discovery result. The main-process log retains the same safe diagnostic fields.

Private builds can bundle several targets as
`{defaultNodeId, nodes: [{id, inviteToken, model, expectedNodeId, label?, hosting?, hardware?}]}`.
`defaultNodeId` is a full configured mesh key. Legacy single-target configurations
remain supported. Each configured multi-target entry has a strict node pin.
The current private build includes the original paid provider and a Phala H200
provider. Its Phala/TDX description is operator-configured metadata; this client
does not verify CPU/GPU TEE attestation. A displayed mesh release signature refers
only to upstream binary provenance.

Selection changes drain old native inference before changing the route. A paid
target already advertised in the joined mesh reuses that membership; otherwise,
the client joins that configured target's invite. Repeated join flags race mesh
bootstraps and are not treated as a way to combine unrelated meshes. Wallet state
and reusable Goose chat sessions survive these route changes.

## Paid inference and Wallet

The saved **mesh-llm (paid)** option joins only a configured private invitation
and selects the default or explicitly chosen paid model/node pair. It connects
without a synthetic completion. Both mesh modes use the native Goose state
machine and local Brave tool; the app leaves payment negotiation and settlement to mesh-llm.
An invocation's answer and tool-continuation completions all count toward its
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
An optional `expectedNodeId` field pins paid inference to one 64-character hex
mesh node public key. When configured, other paid offers are excluded, even for
the same model, and an unavailable pinned node produces an error. Existing
configurations without this field retain their private-mesh selection behavior.
This pins the operator's mesh identity; it does not verify CPU or GPU attestation.

The selected operator processes the current question and up to 12 recent text
messages from the same chat, under a 6,000-byte history budget. Attachments,
deleted or expired messages, and unfinished replies are excluded. GDK handles
the OpenAI-compatible streaming protocol through a declarative provider with
the explicit `/v1/chat/completions` path. A bounded streamed GDK loop lets the
model answer or request the local Brave tool in its first turn; another turn is
made only after executing a requested tool. Ordinary answers use one inference
request, and a search plus answer generally uses two. Mesh charges input/output
invoices per request. Native schemas remain available on continuation turns;
standalone text-form search calls have a narrow validated compatibility parser.
Only the embedded native Rust tool calls Brave; the chosen mesh node receives
bounded public search excerpts and source links for the final answer.
