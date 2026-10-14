// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  IdentityKeyPair,
  KEMKeyPair,
  KyberPreKeyRecord,
  PrivateKey,
} from '@signalapp/libsignal-client';
import { AccountEntropyPool } from '@signalapp/libsignal-client/dist/AccountKeys.js';
import {
  restoreSigDemoRegistrationDraft,
  serializeSigDemoRegistrationDraft,
} from '../ts/util/sigDemoRegistrationDraft.node.ts';
import { STORAGE_KEYS_TO_PRESERVE_WHEN_PRIMARY } from '../ts/types/StorageKeys.std.ts';

function identity() {
  const key = PrivateKey.generate();
  return new IdentityKeyPair(key.getPublicKey(), key);
}

function signedKey(identityKey, keyId) {
  const keyPair = identity();
  return {
    keyId,
    keyPair,
    signature: identityKey.privateKey.sign(keyPair.publicKey.serialize()),
  };
}

function kyberKey(identityKey, keyId) {
  const keyPair = KEMKeyPair.generate();
  return KyberPreKeyRecord.new(
    keyId,
    Date.now(),
    keyPair,
    identityKey.privateKey.sign(keyPair.getPublicKey().serialize())
  );
}

await test('interrupted signup retains every secret and exact public request material across serialization', () => {
  const aciKeyPair = identity();
  const pniKeyPair = identity();
  const material = {
    aciKeyPair,
    pniKeyPair,
    profileKey: randomBytes(32),
    accountEntropyPool: AccountEntropyPool.generate(),
    mediaRootBackupKey: randomBytes(32),
    password: randomBytes(16).toString('base64url'),
    registrationId: 111,
    pniRegistrationId: 222,
    aciSignedPreKey: signedKey(aciKeyPair, 333),
    pniSignedPreKey: signedKey(pniKeyPair, 444),
    aciPqLastResortPreKey: kyberKey(aciKeyPair, 555),
    pniPqLastResortPreKey: kyberKey(pniKeyPair, 666),
    recoveryPassword: randomBytes(32),
  };
  const metadata = {
    serverUrl: 'https://localhost:8443',
    certificateAuthority: 'test certificate',
    inviteCode: 'test invitation kept in encrypted storage',
    displayName: 'Alice',
  };
  const original = serializeSigDemoRegistrationDraft(metadata, material);
  // This simulates the representation read back from encrypted SQLCipher items;
  // no draft or private key is written to an unencrypted test file.
  const restored = restoreSigDemoRegistrationDraft(
    JSON.parse(JSON.stringify(original))
  );
  assert.deepEqual(
    serializeSigDemoRegistrationDraft(metadata, restored),
    original
  );
  for (const kind of ['aci', 'pni']) {
    assert.deepEqual(
      restored[`${kind}KeyPair`].publicKey.serialize(),
      material[`${kind}KeyPair`].publicKey.serialize()
    );
    assert.equal(
      restored[`${kind}KeyPair`].publicKey.verify(
        restored[`${kind}SignedPreKey`].keyPair.publicKey.serialize(),
        restored[`${kind}SignedPreKey`].signature
      ),
      true
    );
    assert.equal(
      restored[`${kind}KeyPair`].publicKey.verify(
        restored[`${kind}PqLastResortPreKey`].publicKey().serialize(),
        restored[`${kind}PqLastResortPreKey`].signature()
      ),
      true
    );
  }
});

await test('primary registration reset preserves the durable pending draft', () => {
  assert.equal(
    STORAGE_KEYS_TO_PRESERVE_WHEN_PRIMARY.includes('sigDemoRegistrationDraft'),
    true
  );
});

await test('unknown draft versions fail without generating replacement identity keys', () => {
  assert.throws(
    () => restoreSigDemoRegistrationDraft({ version: 2 }),
    /Unsupported pending demo registration version/
  );
});
