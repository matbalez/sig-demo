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
pnpm run demo:package --config .sig-demo/client.json --arch arm64
```

Use `--arch x64` for Intel Macs. Share the resulting
`release/sig-demo-macos-arm64.zip` or `release/sig-demo-macos-x64.zip` and one
invitation with each tester. The helper builds and verifies the ad-hoc signed
app in a temporary directory outside cloud-synced folders, then creates the ZIP.
It also leaves a review copy at `release/mac-arm64/sig demo.app` or
`release/mac/sig demo.app`; use the ZIP or the printed signed staging path for
installation. The bundle includes only public server settings. The helper does
not publish or notarize the app.

Implementation details are in [client account creation](CLIENT-PLAN.md) and
[private backend](server/README.md).
