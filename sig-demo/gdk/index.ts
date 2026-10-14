// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable signal-desktop/enforce-file-suffix -- Public package entry point reexports Node bindings and shared types. */
export {
  loadGdk,
  GdkBindings,
  GooseError,
  Provider,
  ProviderStream,
} from './bindings.node.ts';
export type { BindingDiagnostics } from './bindings.node.ts';
export type * from './generated/types.std.ts';
