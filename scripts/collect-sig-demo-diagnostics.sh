#!/bin/sh
# Copyright 2026 sig demo contributors
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
TASK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TASK_NODE="$TASK_ROOT/.sig-demo/toolchain/node-v24.21.0-darwin-arm64/bin/node"
if [ ! -x "$TASK_NODE" ]; then TASK_NODE=$(command -v node); fi
exec "$TASK_NODE" "$TASK_ROOT/scripts/collect-sig-demo-diagnostics.mjs"
