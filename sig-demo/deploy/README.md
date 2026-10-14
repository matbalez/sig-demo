# Small VPS demo deployment

The server workspace package is **`@sig-demo/private-server`**. It imports the
generated upstream backend through `@signalapp/mock-server`, so the deployed
backend does not need the Desktop source or Electron dependencies.

From this repository after installing the workspace and building mock-server:

```sh
pnpm --filter @signalapp/mock-server run build
node sig-demo/deploy/prepare-source.mjs .sig-demo/server-source
```

`server-source` is a minimal temporary workspace containing an empty root
manifest, the generated mock-server, and the private backend. Copy it to
`/opt/sig-demo/source` on the VPS, then install there with
`pnpm install --prod --ignore-scripts`. Symlink
`/opt/sig-demo/source/sig-demo/server` to `/opt/sig-demo/server`. This deliberately
avoids installing the Desktop root's native dependencies.

Install the pinned Linux x64 Node **24.21.0** runtime at `/opt/sig-demo/node`; npm
dependencies include the corresponding Linux libsignal prebuild. Keep server
state separately at `/opt/sig-demo/data`, owned by the service user (`ubuntu` in
the supplied unit). The generated `.js`/`.d.ts` protobuf/source files are already
in the source archive; no compiler or Electron setup is needed on the VPS.

Initialize the final deployment **once**, or copy an already initialized private
state directory to preserve the same client trust configuration:

```sh
cd /opt/sig-demo/server
/opt/sig-demo/node/bin/node --import tsx main.ts init --data-dir /opt/sig-demo/data --port 8443 --client-port 14443
/opt/sig-demo/node/bin/node --import tsx main.ts invite --data-dir /opt/sig-demo/data
/opt/sig-demo/node/bin/node --import tsx main.ts serve --data-dir /opt/sig-demo/data --port 8443 --public --host 0.0.0.0
```

Install `sig-demo.service` at `/etc/systemd/system/sig-demo.service`, then run
`sudo systemctl daemon-reload` and `sudo systemctl enable --now sig-demo`.
`journalctl -u sig-demo` shows its startup status. Open TCP 8443 on the VPS for the
demo clients. Use the public `data/client-config.json` for the fork and add:

```json
"sigDemoRelay": { "host": "51.159.213.86", "port": 8443 }
```

Each desktop owns its loopback TCP relay on port 14443 and forwards opaque TLS to
the VPS. The server's own certificate authenticates `localhost`; only the public
CA and public Signal server parameters go into the client. The server advertises
attachment URLs using the client relay port 14443, independently of its listening
port 8443. Send friends the distinct desktop app and a one-time invite. They do
not need SSH access, a mobile client, a real phone number, or an API key.

This is a small test/demo backend. Keep its state directory out of the source
archive and ship only the public client configuration with the app.
