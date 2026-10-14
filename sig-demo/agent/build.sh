#!/bin/sh
# Copyright 2026 Sig Demo contributors
# SPDX-License-Identifier: AGPL-3.0-only

set -eu
AGENT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_DIR=$(CDPATH= cd -- "$AGENT_DIR/../.." && pwd)
cargo +1.95.0 build --release --locked \
  --manifest-path "$AGENT_DIR/Cargo.toml" \
  --target aarch64-apple-darwin \
  --target-dir "$WORKSPACE_DIR/.sig-demo/agent-build"
mkdir -p "$AGENT_DIR/target/release"
cp "$WORKSPACE_DIR/.sig-demo/agent-build/aarch64-apple-darwin/release/sig-agent" \
  "$AGENT_DIR/target/release/sig-demo-agent"
