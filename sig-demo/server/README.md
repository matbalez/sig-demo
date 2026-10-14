# Private desktop demo backend

This is an experimental Signal-compatible backend for the fork in this repository.
It uses the pinned upstream mock server's HTTP, gRPC, encrypted group, and public
prekey implementations, with private invite registration, real primary desktop
delivery, durable SQLite inboxes, and restartable public-key/group/storage state.
Client messages use the actual upstream libsignal implementation. The server does
not construct simulated phone clients or receive client private identity keys.

Use Node 24.21.0 and the repository's installed workspace dependencies. Build the
mock server protobufs before running these commands:

```sh
node --import tsx sig-demo/server/main.ts init --data-dir sig-demo/server-data
node --import tsx sig-demo/server/main.ts invite --data-dir sig-demo/server-data
node --import tsx sig-demo/server/main.ts serve --data-dir sig-demo/server-data --port 8443
```

`init` creates new private TLS/Signal server identities and refuses to replace an
existing deployment. Give desktop clients only `client-config.json`. Keep the
other files, including the CA private key, server signing keys, SQLite database,
and CDN directory, private and backed up together. The data directory belongs
outside source control. TLS certificates are for `localhost`; remote clients use
the fork's TCP relay to preserve TLS to the VPS. `serve --public` explicitly allows
public binding. See [the small VPS deployment](../deploy/README.md).

`invite` prints a one-time token, valid for seven days by default (`--hours` changes
the duration). Exact request retries return the original account response. Changed
credentials cannot reuse a consumed token. Production Signal registration, mobile
linking, and SMS verification are blocked. The initial compatibility build assigns
an internal synthetic `+999…` identifier; participants supply no real phone number,
and no SMS or production Signal account is involved.

The persisted client material consists of public identity/prekeys, encrypted
profiles/groups/storage, password hashes, and queued ciphertext envelopes. An
envelope is deleted after its desktop acknowledges receipt; interrupted delivery
may be retried with the same GUID. This gives at-least-once delivery, as expected
by Signal's deduplication. Account recovery, server migrations, abuse handling,
calling, backups, and full production feature parity are outside this first demo.
The server is not an audited substitute for production Signal.

The state adapter is intentionally pinned to the vendored upstream source layout;
upstream upgrades require the restart and messaging tests to pass again.
