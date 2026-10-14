// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable max-classes-per-file -- Reader, writer and codec share one wire format. */
// UniFFI's specified big-endian binary serialization. This is a generic wire
// codec: provider requests remain native SDK records, never a custom JSON API.
import { Buffer } from 'node:buffer';
import { camelCase } from './schema.std.ts';
import type { FieldSchema, InterfaceSchema, WireType } from './schema.std.ts';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 100_000;
function required<T>(value: T | undefined): T {
  if (value === undefined) invalid();
  return value;
}
function invalid(): never {
  throw new TypeError('Invalid value for the GDK UniFFI interface.');
}

export type ObjectCodec = Readonly<{
  lowerObject: (value: unknown, name: string) => bigint;
  liftObject: (value: bigint, name: string) => unknown;
}>;

class Writer {
  readonly parts: Array<Buffer<ArrayBuffer>> = [];
  length = 0;

  append(value: Buffer<ArrayBuffer>): void {
    this.length += value.length;
    if (this.length > MAX_BUFFER_BYTES) invalid();
    this.parts.push(value);
  }

  integer(value: unknown, bytes: number, signed: boolean): void {
    const buffer = Buffer.alloc(bytes);
    if (bytes === 8) {
      if (typeof value !== 'bigint' && !Number.isSafeInteger(value)) invalid();
      const integer = BigInt(value as number | bigint);
      if (signed) buffer.writeBigInt64BE(integer);
      else buffer.writeBigUInt64BE(integer);
    } else {
      if (!Number.isInteger(value)) invalid();
      if (signed) buffer.writeIntBE(value as number, 0, bytes);
      else buffer.writeUIntBE(value as number, 0, bytes);
    }
    this.append(buffer);
  }

  float(value: unknown, bytes: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
    const buffer = Buffer.alloc(bytes);
    if (bytes === 4) buffer.writeFloatBE(value);
    else buffer.writeDoubleBE(value);
    this.append(buffer);
  }

  finish(): Buffer<ArrayBuffer> {
    return Buffer.concat(this.parts, this.length);
  }
}

class Reader {
  offset = 0;
  readonly bytes: Buffer<ArrayBuffer>;
  constructor(bytes: Buffer<ArrayBuffer>) {
    this.bytes = bytes;
  }

  take(count: number): Buffer<ArrayBuffer> {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.bytes.length - this.offset
    )
      invalid();
    const value = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  integer(bytes: number, signed: boolean): number | bigint {
    const buffer = this.take(bytes);
    if (bytes === 8)
      return signed ? buffer.readBigInt64BE() : buffer.readBigUInt64BE();
    return signed ? buffer.readIntBE(0, bytes) : buffer.readUIntBE(0, bytes);
  }

  float(bytes: number): number {
    const buffer = this.take(bytes);
    return bytes === 4 ? buffer.readFloatBE() : buffer.readDoubleBE();
  }

  count(): number {
    const count = this.integer(4, true) as number;
    if (count < 0 || count > MAX_ITEMS) invalid();
    return count;
  }
}

export class WireCodec {
  readonly #records: InterfaceSchema['records'];
  readonly #enums: InterfaceSchema['enums'];
  readonly objects: ObjectCodec;
  constructor(schema: InterfaceSchema, objects: ObjectCodec) {
    this.objects = objects;
    this.#records = schema.records;
    this.#enums = schema.enums;
  }

  encode(type: WireType, value: unknown): Buffer<ArrayBuffer> {
    // UniFFI String.lower is raw UTF-8. Nested String.write has a length prefix.
    if (type.kind === 'string') {
      if (typeof value !== 'string') invalid();
      const buffer = Buffer.from(value, 'utf8');
      if (buffer.length > MAX_BUFFER_BYTES) invalid();
      return buffer;
    }
    const writer = new Writer();
    this.#write(writer, type, value);
    return writer.finish();
  }

  decode(type: WireType, bytes: Buffer<ArrayBuffer>): unknown {
    if (bytes.length > MAX_BUFFER_BYTES) invalid();
    if (type.kind === 'string') return bytes.toString('utf8');
    const reader = new Reader(bytes);
    const result = this.#read(reader, type);
    if (reader.offset !== bytes.length) invalid();
    return result;
  }

  #writeFields(
    writer: Writer,
    fields: ReadonlyArray<FieldSchema>,
    value: unknown
  ): void {
    if (!value || typeof value !== 'object') invalid();
    const record = value as Record<string, unknown>;
    for (const field of fields) {
      let fieldValue = record[camelCase(field.name)];
      if (fieldValue === undefined && Object.hasOwn(field, 'default'))
        fieldValue = field.default;
      this.#write(writer, field.type, fieldValue);
    }
  }

  #readFields(
    reader: Reader,
    fields: ReadonlyArray<FieldSchema>
  ): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    for (const field of fields)
      value[camelCase(field.name)] = this.#read(reader, field.type);
    return value;
  }

  #write(writer: Writer, type: WireType, value: unknown): void {
    switch (type.kind) {
      case 'optional':
        writer.integer(value == null ? 0 : 1, 1, false);
        if (value != null) this.#write(writer, required(type.inner), value);
        return;
      case 'boolean':
        if (typeof value !== 'boolean') invalid();
        writer.integer(value ? 1 : 0, 1, true);
        return;
      case 'string': {
        if (typeof value !== 'string') invalid();
        const buffer = Buffer.from(value, 'utf8');
        writer.integer(buffer.length, 4, true);
        writer.append(buffer);
        return;
      }
      case 'bytes': {
        if (!(value instanceof Uint8Array)) invalid();
        const buffer = Buffer.from(value as Uint8Array<ArrayBuffer>);
        writer.integer(buffer.length, 4, true);
        writer.append(buffer);
        return;
      }
      case 'sequence':
      case 'set': {
        if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid();
        const items = value as ReadonlyArray<unknown>;
        writer.integer(items.length, 4, true);
        for (const item of items)
          this.#write(writer, required(type.inner), item);
        return;
      }
      case 'map': {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          invalid();
        const entries =
          value instanceof Map ? [...value.entries()] : Object.entries(value);
        if (entries.length > MAX_ITEMS) invalid();
        writer.integer(entries.length, 4, true);
        for (const [key, item] of entries) {
          this.#write(writer, required(type.key), key);
          this.#write(writer, required(type.value), item);
        }
        return;
      }
      case 'record': {
        const definition = this.#records.find(
          record => record.name === type.name
        );
        if (!definition) invalid();
        this.#writeFields(writer, definition.fields, value);
        return;
      }
      case 'enum': {
        const definition = this.#enums.find(
          enumeration => enumeration.name === type.name
        );
        if (!definition) invalid();
        const name = definition.flat
          ? value
          : (value as { kind?: unknown })?.kind;
        const index = definition.variants.findIndex(
          variant => variant.name === name
        );
        if (index < 0) invalid();
        const variant = definition.variants[index];
        if (!variant) invalid();
        writer.integer(index + 1, 4, true);
        this.#writeFields(writer, variant.fields, definition.flat ? {} : value);
        return;
      }
      case 'object':
        writer.integer(
          this.objects.lowerObject(value, required(type.name)),
          8,
          false
        );
        return;
      case 'float32':
        writer.float(value, 4);
        return;
      case 'float64':
        writer.float(value, 8);
        return;
      default: {
        const match = /^(u?int)(8|16|32|64)$/.exec(type.kind);
        if (!match) invalid();
        writer.integer(value, Number(match[2]) / 8, match[1] === 'int');
      }
    }
  }

  #read(reader: Reader, type: WireType): unknown {
    switch (type.kind) {
      case 'optional': {
        const flag = reader.integer(1, false);
        if (flag === 0) return null;
        if (flag !== 1) invalid();
        return this.#read(reader, required(type.inner));
      }
      case 'boolean': {
        const flag = reader.integer(1, true);
        if (flag !== 0 && flag !== 1) invalid();
        return flag === 1;
      }
      case 'string':
        return reader.take(reader.integer(4, true) as number).toString('utf8');
      case 'bytes':
        return Buffer.from(reader.take(reader.integer(4, true) as number));
      case 'sequence':
      case 'set': {
        const length = reader.count();
        return Array.from({ length }, () =>
          this.#read(reader, required(type.inner))
        );
      }
      case 'map': {
        const value: Record<string, unknown> = Object.create(null);
        const count = reader.count();
        for (let index = 0; index < count; index += 1) {
          const key = this.#read(reader, required(type.key));
          if (typeof key !== 'string') invalid();
          value[key] = this.#read(reader, required(type.value));
        }
        return value;
      }
      case 'record': {
        const definition = this.#records.find(
          record => record.name === type.name
        );
        if (!definition) invalid();
        return this.#readFields(reader, definition.fields);
      }
      case 'enum': {
        const definition = this.#enums.find(
          enumeration => enumeration.name === type.name
        );
        const index = Number(reader.integer(4, true)) - 1;
        const variant = definition?.variants[index];
        if (!definition || !variant) invalid();
        if (definition.flat) return variant.name;
        return {
          kind: variant.name,
          ...this.#readFields(reader, variant.fields),
        };
      }
      case 'object':
        return this.objects.liftObject(
          reader.integer(8, false) as bigint,
          required(type.name)
        );
      case 'float32':
        return reader.float(4);
      case 'float64':
        return reader.float(8);
      default: {
        const match = /^(u?int)(8|16|32|64)$/.exec(type.kind);
        if (!match) invalid();
        return reader.integer(Number(match[2]) / 8, match[1] === 'int');
      }
    }
  }
}
