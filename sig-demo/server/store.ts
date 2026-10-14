// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';

export class DemoStore {
  public readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (username TEXT PRIMARY KEY, salt BLOB NOT NULL, hash BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (
        hash TEXT PRIMARY KEY, expires INTEGER NOT NULL,
        request_hash TEXT, response TEXT
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL,
        envelope BLOB NOT NULL, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_target ON inbox(target,id);
      CREATE TABLE IF NOT EXISTS directory (aci TEXT PRIMARY KEY, display_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (path TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  }

  public transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public saveState(state: unknown): void {
    this.db
      .prepare(
        'INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
      )
      .run(serialize(state));
  }

  public loadState(): unknown {
    const row = this.db.prepare('SELECT payload FROM state WHERE id=1').get();
    return row
      ? deserialize(Buffer.from(row.payload as Uint8Array))
      : undefined;
  }

  public addCredential(username: string, password: string): void {
    const salt = randomBytes(32);
    const hash = scryptSync(password, salt, 64);
    this.db
      .prepare('INSERT OR REPLACE INTO credentials VALUES(?,?,?)')
      .run(username, salt, hash);
  }

  public verifyCredential(username: string, password: string): boolean {
    const row = this.db
      .prepare('SELECT salt,hash FROM credentials WHERE username=?')
      .get(username);
    if (!row) {
      return false;
    }
    const actual = scryptSync(
      password,
      Buffer.from(row.salt as Uint8Array),
      64
    );
    const expected = Buffer.from(row.hash as Uint8Array);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  public createInvite(hours = 168): string {
    if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
      throw new Error('Invite duration must be between 0 and 8760 hours');
    }
    const code = randomBytes(24).toString('base64url');
    this.db
      .prepare('INSERT INTO invites(hash,expires) VALUES(?,?)')
      .run(hashText(code), Date.now() + hours * 3600000);
    return code;
  }

  public findInvite(
    code: string
  ):
    | { expires: number; request_hash: string | null; response: string | null }
    | undefined {
    return this.db
      .prepare('SELECT expires,request_hash,response FROM invites WHERE hash=?')
      .get(hashText(code)) as ReturnType<DemoStore['findInvite']>;
  }

  public consumeInvite(
    code: string,
    requestHash: string,
    response: unknown
  ): void {
    this.db
      .prepare('UPDATE invites SET request_hash=?,response=? WHERE hash=?')
      .run(requestHash, JSON.stringify(response), hashText(code));
  }

  public enqueue(target: string, envelope: Uint8Array): void {
    const existing = this.db
      .prepare('SELECT COUNT(*) AS count FROM inbox WHERE target=?')
      .get(target);
    if (Number(existing?.count) >= 10000 || envelope.byteLength > 1024 * 1024) {
      throw new Error('Demo inbox capacity exceeded');
    }
    this.db
      .prepare('INSERT INTO inbox(target,envelope,created) VALUES(?,?,?)')
      .run(target, envelope, Date.now());
  }

  public firstPending(
    target: string
  ): { id: number; envelope: Buffer<ArrayBuffer> } | undefined {
    const row = this.db
      .prepare(
        'SELECT id,envelope FROM inbox WHERE target=? ORDER BY id LIMIT 1'
      )
      .get(target);
    return row
      ? {
          id: Number(row.id),
          envelope: Buffer.from(row.envelope as Uint8Array),
        }
      : undefined;
  }

  public acknowledge(id: number): void {
    this.db.prepare('DELETE FROM inbox WHERE id=?').run(id);
  }

  public close(): void {
    this.db.close();
  }
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
