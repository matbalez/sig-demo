# sig demo

A small, private macOS desktop demo fork of Signal Desktop. Participants create
fresh demo accounts with a one-time invitation and display name, then use the
existing conversation and group UI. Signup needs no phone, real telephone number,
SMS, or linked mobile app. The compatibility backend assigns an internal
synthetic `+999…` identifier.

The demo has its own app ID (`dev.matbalez.sig-demo`), server identities, and
SQLCipher profiles at `~/Library/Application Support/sig demo/<profile>/`.
Production Signal accounts and data are not used. Each profile is an independent
demo identity. The private roster supplies contacts; new contacts exchange profile
keys through normal encrypted Signal messages. Allow the roster to populate
(up to 30 seconds), then start a chat or create a group. Initial group invitations
can be pending until participants finish exchanging their profiles.

This is a closed test/demo for a handful of friends. One-to-one messaging and
Groups V2 are the intended scope; calling, backups, mobile clients, and full
Signal feature parity are outside this demo.

Type `@sig` and a question in any chat to run that sender's local Sig helper.
Everyone in the chat sees one Sig reply for that query, updated as text streams;
the next question gets a separate reply. Responses travel through the existing
encrypted direct or group messaging path. Sig receives the current question and
up to 12 recent completed text messages from that chat, including earlier Sig
answers. History has a 6,000-byte budget (roughly 2,000 tokens), with long messages
shortened. Attachments, deleted or expired messages, and unfinished replies are
excluded. Each invocation takes a fresh history snapshot; there is no separate
persistent agent memory. See [Sig helper](agent/README.md).

With **mesh-llm**, Sig can call a local Brave web-search tool when a question needs
current information or explicitly asks for a search. The Rust helper sends a concise
search query to Brave's LLM Context API and returns bounded excerpts and source
URLs to the selected inference provider. It permits at most two searches per
question and asks Sig to cite the source URLs. The approved Brave demo key is
bundled with private downloads, so friends need no API setup. The key is never
sent to mesh nodes. Brave receives search queries under its
[Search API privacy notice](https://api-dashboard.search.brave.com/app/documentation/general/privacy-policy).
With **ChatGPT**, Sig uses OpenAI's built-in web search through GDK's Responses
API path. ChatGPT requests do not load the Brave tool or receive its credential.

**General → Inference** selects the provider for the next question. The default
is **mesh-llm**: a bundled client joins a randomly selected public mesh and picks
an available free text-inference node at random. The selected node processes the
question and bounded chat context. **ChatGPT** uses the existing bundled OpenAI credential.
The setting is saved on each Mac, and provider changes leave earlier replies intact.
If the mesh is unavailable, Sig reports that rather than silently sending the
question to OpenAI.

At app startup, sig demo stops other `mesh-llm` processes owned by the current
user, then starts its bundled version on local ports 9337 and 3131. This interrupts
other mesh work on the Mac. Its node identity, configuration, caches, and join
token are separate from an existing mesh installation. The sidecar is client-only:
it does not download models or share the Mac's GPU. It exits when sig demo quits.
The connection is prepared while the app opens. Public bootstrap nodes are raced
in parallel, and eligible bootstrap hints are cached for up to 24 hours to speed
up later launches. An unavailable cache falls back to fresh public discovery.
Startup also runs a small, synthetic GDK inference completion on the chosen free
node to prepare its model and tool prompt before the first chat query. A slow or
unavailable node is skipped in favor of one other randomly selected free host.
The probe sends no chat history, uses no API credentials, and runs no web search.
Questions share this preparation instead of starting a second cold request.
See [bundled mesh sidecar](mesh/README.md).

Use **Node 24.21.0**, **pnpm 11.24.0**, macOS Xcode Command Line Tools, and OpenSSL.
From the repository root:

```sh
nvm use
pnpm install
pnpm --filter @signalapp/types run build
pnpm --filter @signalapp/windows-ucv run build
pnpm --filter @signalapp/mock-server run build
pnpm run generate
```

The desktop launcher reads `.sig-demo/client.json` by default. For the existing
VPS demo, use the supplied public configuration; the local reference copy is
`.sig-demo/vps-client.json`. Invitation tokens are kept separately in the ignored
`.sig-demo/vps-invites.json` file. Give each friend one token, rather than shipping
that file with the app.

For a **fresh local backend**, initialize its own identities once, generate an
invitation, and start it:

```sh
pnpm run demo:server init --data-dir .sig-demo/server-data --port 8443
pnpm run demo:server invite --data-dir .sig-demo/server-data
cp .sig-demo/server-data/client-config.json .sig-demo/client.json
pnpm run demo:server serve --data-dir .sig-demo/server-data --port 8443
```

`invite` prints a one-time token valid for seven days by default. Use `--hours`
to change that duration. `init` refuses to replace existing server identities.
In another terminal, start the desktop and enter the invitation:

```sh
pnpm run start --profile alice
```

To use another public configuration or another independent demo account:

```sh
pnpm run start --config .sig-demo/client.json --profile bob
```

With the same VPS relay configuration, close one demo profile before opening
another on the same Mac; each running app owns its configured local relay port.

The VPS setup keeps libsignal's localhost test transport. Each desktop listens
on its configured loopback port (14443 in the supplied VPS configuration) and
forwards **opaque TLS bytes** to the approved private VPS on TCP 8443. TLS ends at
the private server, authenticated with its own CA. The relay neither decrypts
messages nor terminates TLS. Chat, group, storage, and attachment URLs all use
that local relay. Friends need the app and an invitation; they need no SSH access.
See [VPS deployment](deploy/README.md) for the server layout and commands.

On the VPS, private state lives in `/opt/sig-demo/data/`: `server-secrets.json`,
private TLS/CA keys, `demo.sqlite`, and `cdn3/`. Only
`/opt/sig-demo/data/client-config.json` is copied into the desktop configuration.
For a local backend, these same files live under `.sig-demo/server-data/`.
Pending client signup material stays inside its encrypted profile, so interrupted
setup can resume with the same invitation and keys.

After generating current assets, package a local macOS app:

```sh
sh sig-demo/agent/build.sh
node scripts/fetch-sig-demo-mesh.mjs
pnpm run demo:package --config .sig-demo/client.json --arch arm64
```

The local helper needs the approved demo credentials in ignored
`.sig-demo/agent.env` (`OPENAI_API_KEY`) and `.sig-demo/brave.env`
(`BRAVE_SEARCH_API_KEY`). The packager accepts other private credential files
with `--agent-key-file` and `--brave-key-file`. The packaged helper gets the demo
credentials from an Electron resource, and each tester runs it on their own Mac.
Mesh requests receive no OpenAI credential. The packager includes the verified
official mesh-llm 0.78.1 macOS bundle and its Apache-2.0 license.

This build supports Apple Silicon Macs. Share the resulting
`release/sig-demo-macos-arm64.zip` and one
invitation with each tester. The helper builds and verifies the ad-hoc signed
app in a temporary directory outside cloud-synced folders, then creates the ZIP.
It also leaves a review copy at `release/mac-arm64/sig demo.app`;
use the ZIP or the printed signed staging path for
installation. Server settings in the bundle are public; invitations and server
private keys stay separate. The bundle also carries the approved demo agent
credentials, so distribute it through the private download repository. The helper
does not publish or notarize the app.

Implementation details are in [client account creation](CLIENT-PLAN.md) and
[private backend](server/README.md).
