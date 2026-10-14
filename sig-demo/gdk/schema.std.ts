// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

export type WireType = Readonly<{
  kind: string;
  name?: string;
  inner?: WireType;
  key?: WireType;
  value?: WireType;
}>;
export type FieldSchema = Readonly<{
  name: string;
  type: WireType;
  default?: unknown;
}>;
export type FfiSchema = Readonly<{
  symbol: string;
  arguments: ReadonlyArray<string>;
  return: string;
  status: boolean;
}>;
export type CallableSchema = Readonly<{
  name: string;
  async: boolean;
  ffi: FfiSchema;
  arguments: ReadonlyArray<FieldSchema>;
  return: WireType | null;
  futureFlavor: string;
  error: string | null;
}>;
export type ObjectSchema = Readonly<{
  name: string;
  clone: FfiSchema;
  free: FfiSchema;
  methods: ReadonlyArray<CallableSchema>;
}>;
export type InterfaceSchema = Readonly<{
  sdkVersion: string;
  uniffiVersion: string;
  namespace: string;
  contractVersion: number;
  contractSymbol: string;
  checksums: ReadonlyArray<{ symbol: string; value: number }>;
  buffers: { allocate: FfiSchema; fromBytes: FfiSchema; free: FfiSchema };
  futures: Readonly<
    Record<
      string,
      { poll: string; complete: FfiSchema; cancel: string; free: string }
    >
  >;
  records: ReadonlyArray<{ name: string; fields: ReadonlyArray<FieldSchema> }>;
  enums: ReadonlyArray<{
    name: string;
    flat: boolean;
    variants: ReadonlyArray<{
      name: string;
      fields: ReadonlyArray<FieldSchema>;
    }>;
  }>;
  functions: ReadonlyArray<CallableSchema>;
  objects: ReadonlyArray<ObjectSchema>;
}>;

export const camelCase = (name: string): string =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
