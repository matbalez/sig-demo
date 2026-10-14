// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import {
  IdentityKeyPair,
  KyberPreKeyRecord,
  PrivateKey,
} from '@signalapp/libsignal-client';
import * as Bytes from '../Bytes.std.ts';
import type {
  CompatSignedPreKeyType,
  KeyPairType,
} from '../textsecure/Types.d.ts';

type SerializedSignedPreKey = Readonly<{
  keyId: number;
  privateKey: string;
  signature: string;
}>;

export type SigDemoRegistrationMaterial = Readonly<{
  aciKeyPair: KeyPairType;
  pniKeyPair: KeyPairType;
  profileKey: Uint8Array<ArrayBuffer>;
  accountEntropyPool: string;
  mediaRootBackupKey: Uint8Array<ArrayBuffer>;
  password: string;
  registrationId: number;
  pniRegistrationId: number;
  aciSignedPreKey: CompatSignedPreKeyType;
  pniSignedPreKey: CompatSignedPreKeyType;
  aciPqLastResortPreKey: KyberPreKeyRecord;
  pniPqLastResortPreKey: KyberPreKeyRecord;
  recoveryPassword: Uint8Array<ArrayBuffer>;
}>;

// This object must only be persisted inside the profile's SQLCipher database.
export type SigDemoRegistrationDraft = Readonly<{
  version: 1;
  serverUrl: string;
  certificateAuthority: string;
  inviteCode: string;
  displayName: string;
  aciIdentityPrivateKey: string;
  pniIdentityPrivateKey: string;
  profileKey: string;
  accountEntropyPool: string;
  mediaRootBackupKey: string;
  password: string;
  registrationId: number;
  pniRegistrationId: number;
  aciSignedPreKey: SerializedSignedPreKey;
  pniSignedPreKey: SerializedSignedPreKey;
  aciPqLastResortPreKey: string;
  pniPqLastResortPreKey: string;
  recoveryPassword: string;
}>;

function serializeSignedPreKey(
  key: CompatSignedPreKeyType
): SerializedSignedPreKey {
  return {
    keyId: key.keyId,
    privateKey: Bytes.toBase64(key.keyPair.privateKey.serialize()),
    signature: Bytes.toBase64(key.signature),
  };
}

function restoreIdentity(privateKey: string): KeyPairType {
  const key = PrivateKey.deserialize(Bytes.fromBase64(privateKey));
  return new IdentityKeyPair(key.getPublicKey(), key);
}

function restoreSignedPreKey(
  key: SerializedSignedPreKey
): CompatSignedPreKeyType {
  return {
    keyId: key.keyId,
    keyPair: restoreIdentity(key.privateKey),
    signature: Bytes.fromBase64(key.signature),
  };
}

export function serializeSigDemoRegistrationDraft(
  metadata: Pick<
    SigDemoRegistrationDraft,
    'serverUrl' | 'certificateAuthority' | 'inviteCode' | 'displayName'
  >,
  material: SigDemoRegistrationMaterial
): SigDemoRegistrationDraft {
  return {
    version: 1,
    ...metadata,
    aciIdentityPrivateKey: Bytes.toBase64(
      material.aciKeyPair.privateKey.serialize()
    ),
    pniIdentityPrivateKey: Bytes.toBase64(
      material.pniKeyPair.privateKey.serialize()
    ),
    profileKey: Bytes.toBase64(material.profileKey),
    accountEntropyPool: material.accountEntropyPool,
    mediaRootBackupKey: Bytes.toBase64(material.mediaRootBackupKey),
    password: material.password,
    registrationId: material.registrationId,
    pniRegistrationId: material.pniRegistrationId,
    aciSignedPreKey: serializeSignedPreKey(material.aciSignedPreKey),
    pniSignedPreKey: serializeSignedPreKey(material.pniSignedPreKey),
    aciPqLastResortPreKey: Bytes.toBase64(
      material.aciPqLastResortPreKey.serialize()
    ),
    pniPqLastResortPreKey: Bytes.toBase64(
      material.pniPqLastResortPreKey.serialize()
    ),
    recoveryPassword: Bytes.toBase64(material.recoveryPassword),
  };
}

export function restoreSigDemoRegistrationDraft(
  draft: SigDemoRegistrationDraft
): SigDemoRegistrationMaterial {
  if (draft.version !== 1) {
    throw new Error('Unsupported pending demo registration version');
  }
  return {
    aciKeyPair: restoreIdentity(draft.aciIdentityPrivateKey),
    pniKeyPair: restoreIdentity(draft.pniIdentityPrivateKey),
    profileKey: Bytes.fromBase64(draft.profileKey),
    accountEntropyPool: draft.accountEntropyPool,
    mediaRootBackupKey: Bytes.fromBase64(draft.mediaRootBackupKey),
    password: draft.password,
    registrationId: draft.registrationId,
    pniRegistrationId: draft.pniRegistrationId,
    aciSignedPreKey: restoreSignedPreKey(draft.aciSignedPreKey),
    pniSignedPreKey: restoreSignedPreKey(draft.pniSignedPreKey),
    aciPqLastResortPreKey: KyberPreKeyRecord.deserialize(
      Bytes.fromBase64(draft.aciPqLastResortPreKey)
    ),
    pniPqLastResortPreKey: KyberPreKeyRecord.deserialize(
      Bytes.fromBase64(draft.pniPqLastResortPreKey)
    ),
    recoveryPassword: Bytes.fromBase64(draft.recoveryPassword),
  };
}
