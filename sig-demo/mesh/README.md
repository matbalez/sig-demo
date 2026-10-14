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
The sidecar receives no OpenAI key. Public discovery advertises meshes, rather
than individual serving nodes: sig demo shuffles usable public listings, joins
one, and chooses a random available free text-inference node from `/v1/models`.
An `x-mesh-target` header pins inference to that node. A missing node produces an
error; Sig can discover another for the next request. There is no automatic
fallback to ChatGPT and no paid-node funding.

The selected operator processes the submitted question. Only the current query
is provided; chat history and attachments stay out of inference. GDK handles
the OpenAI-compatible streaming protocol through a declarative provider with
the explicit `/v1/chat/completions` path.
