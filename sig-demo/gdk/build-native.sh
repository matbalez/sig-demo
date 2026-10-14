#!/bin/sh
# Copyright 2026 Sig Demo contributors
# SPDX-License-Identifier: AGPL-3.0-only

set -eu
GDK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_DIR=$(CDPATH= cd -- "$GDK_DIR/../.." && pwd)
NATIVE_DIR="$GDK_DIR/native"
BUILD_DIR="$WORKSPACE_DIR/.sig-demo/agent-build"

# goose-sdk itself owns the UniFFI scaffolding, native providers, futures and
# streams. Build that package directly, retaining its official exported API.
cargo +1.95.0 build --release --locked \
  --manifest-path "$NATIVE_DIR/Cargo.toml" \
  --package goose-sdk --lib --bin goose-uniffi-bindgen \
  --target aarch64-apple-darwin --target-dir "$BUILD_DIR"

mkdir -p "$NATIVE_DIR/target/release"
cp "$BUILD_DIR/aarch64-apple-darwin/release/libgoose_sdk.dylib" \
  "$NATIVE_DIR/target/release/libgoose_sdk.dylib"
/usr/bin/install_name_tool -id '@rpath/libgoose_sdk.dylib' \
  "$NATIVE_DIR/target/release/libgoose_sdk.dylib"
# Editing the Mach-O identifier invalidates Cargo's ad hoc code signature.
# Sign the final development image as well as the packaged resource image.
/usr/bin/codesign --force --sign - \
  "$NATIVE_DIR/target/release/libgoose_sdk.dylib"
cp "$BUILD_DIR/aarch64-apple-darwin/release/goose-uniffi-bindgen" \
  "$NATIVE_DIR/target/release/goose-uniffi-bindgen"
mkdir -p "$WORKSPACE_DIR/.sig-demo/gdk"
cp "$NATIVE_DIR/target/release/libgoose_sdk.dylib" \
  "$WORKSPACE_DIR/.sig-demo/gdk/libgoose_sdk.dylib"

# Official Python bindings provide a readable reference for ABI symbols,
# checksums, records and ownership; the application loads TypeScript bindings.
REFERENCE_DIR="$WORKSPACE_DIR/.sig-demo/gdk-uniffi-reference"
mkdir -p "$REFERENCE_DIR"
(
  cd "$NATIVE_DIR"
  "$NATIVE_DIR/target/release/goose-uniffi-bindgen" generate \
    --library "$NATIVE_DIR/target/release/libgoose_sdk.dylib" \
    --language python --out-dir "$REFERENCE_DIR" --no-format --metadata-no-deps
)

# The application-specific generator extracts the same official UniFFI metadata
# into TypeScript types and checksummed native ABI descriptors.
mkdir -p "$GDK_DIR/generated"
cargo +1.95.0 run --locked \
  --manifest-path "$GDK_DIR/bindgen/Cargo.toml" \
  --target-dir "$WORKSPACE_DIR/.sig-demo/gdk-bindgen-build" -- \
  "$NATIVE_DIR/target/release/libgoose_sdk.dylib" \
  "$GDK_DIR/generated/schema.json"
node "$GDK_DIR/generate-types.node.mjs"

# The application facade embeds the published goose-agent state machine.
AGENT_DIR="$GDK_DIR/native-agent"
cargo +1.95.0 build --release --locked \
  --manifest-path "$AGENT_DIR/Cargo.toml" \
  --target aarch64-apple-darwin --target-dir "$BUILD_DIR"
mkdir -p "$AGENT_DIR/target/release"
AGENT_LIBRARY="$AGENT_DIR/target/release/libsig_demo_agent.dylib"
cp "$BUILD_DIR/aarch64-apple-darwin/release/libsig_demo_agent.dylib" \
  "$AGENT_LIBRARY.building"
/usr/bin/install_name_tool -id '@rpath/libsig_demo_agent.dylib' "$AGENT_LIBRARY.building"
/usr/bin/codesign --force --sign - "$AGENT_LIBRARY.building"
mv -f "$AGENT_LIBRARY.building" "$AGENT_LIBRARY"
mkdir -p "$GDK_DIR/generated-agent"
cargo +1.95.0 run --locked \
  --manifest-path "$GDK_DIR/bindgen/Cargo.toml" \
  --target-dir "$WORKSPACE_DIR/.sig-demo/gdk-bindgen-build" -- \
  "$AGENT_LIBRARY" "$GDK_DIR/generated-agent/schema.json" sig_demo_agent
node "$GDK_DIR/generate-types.node.mjs" "$GDK_DIR/generated-agent"
