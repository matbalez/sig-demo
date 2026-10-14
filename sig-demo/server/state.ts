// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

// This adapter deliberately targets the pinned, vendored upstream mock implementation.
// Its TypeScript private fields are ordinary runtime properties, not JavaScript # fields.
// Only public client keys and encrypted group/storage data are exported. Socket objects,
// simulated PrimaryDevice clients, test queues, and plaintext account passwords are excluded.

import { KEMPublicKey, PublicKey } from '@signalapp/libsignal-client';
import {
  GroupPublicParams,
  ProfileKeyCommitment,
  ServerZkProfileOperations,
} from '@signalapp/libsignal-client/zkgroup';
import {
  Device,
  type DeviceOptions,
} from '@signalapp/mock-server/src/data/device';
import { ServerGroup } from '@signalapp/mock-server/src/server/group';
import type { Server as BaseServer } from '@signalapp/mock-server/src/server/base';
import { ServiceIdKind } from '@signalapp/mock-server/src/types';
import { signalservice as Proto } from '@signalapp/mock-server/protos/compiled';

type NativeKey = { serialize(): Uint8Array };
type KeyRecord = {
  keyId: number;
  publicKey: NativeKey;
  signature?: Buffer<ArrayBuffer>;
};
type PublicKeys = {
  identityKey: PublicKey;
  signedPreKey: KeyRecord;
  lastResortKey: KeyRecord;
  preKeys: KeyRecord[];
  kyberPreKeys: KeyRecord[];
  preKeyIterator?: unknown;
  kyberPreKeyIterator?: unknown;
};
type EncodedKey = {
  keyId: number;
  publicKey: Buffer<ArrayBuffer>;
  signature?: Buffer<ArrayBuffer>;
};
type EncodedKeys = {
  identityKey: Buffer<ArrayBuffer>;
  signedPreKey: EncodedKey;
  lastResortKey: EncodedKey;
  preKeys: EncodedKey[];
  kyberPreKeys: EncodedKey[];
};
type EncodedDevice = {
  options: DeviceOptions;
  capabilities: Device['capabilities'];
  accessKey?: Buffer<ArrayBuffer>;
  profileName?: Buffer<ArrayBuffer>;
  profileKeyCommitment?: Buffer<ArrayBuffer>;
  keys: Array<[ServiceIdKind, EncodedKeys]>;
};

const PLAIN_FIELDS = [
  'usedServiceIds',
  'usedProvisionIds',
  'storageManifestByAci',
  'storageItemsByAci',
  'registrationLockTokensByACI',
  'attachments',
  'stickerPacks',
  'aciByUsername',
  'aciByReservedUsername',
  'usernameByAci',
  'reservedUsernameByAci',
  'usernameLinkIdByServiceId',
  'usernameLinkById',
  'remoteConfig',
] as const;

export type Snapshot = {
  version: 1;
  devices: EncodedDevice[];
  fields: Record<string, unknown>;
  storageAuth: Array<{ username: string; password: string; device: string }>;
  groups: Array<{ key: string; changes: Uint8Array<ArrayBuffer> }>;
};

function privateFields(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

export function allDevices(server: BaseServer): Device[] {
  const entries = privateFields(server).devices as Map<string, Device[]>;
  if (!(entries instanceof Map)) {
    throw new Error('Upstream state layout changed: devices');
  }
  return [...entries.values()].flat();
}

function encodeKey(key: KeyRecord): EncodedKey {
  return {
    keyId: key.keyId,
    publicKey: Buffer.from(key.publicKey.serialize()),
    signature: key.signature,
  };
}

export function exportState(server: BaseServer): Snapshot {
  const fields = privateFields(server);
  const devices = allDevices(server).map(device => {
    const keys = privateFields(device).keys as Map<ServiceIdKind, PublicKeys>;
    return {
      options: {
        aci: device.aci,
        pni: device.pni,
        number: device.number,
        deviceId: device.deviceId,
        isProvisioned: device.isProvisioned,
        registrationId: device.getCheckedRegistrationId(ServiceIdKind.ACI),
        pniRegistrationId: device.pni
          ? device.getCheckedRegistrationId(ServiceIdKind.PNI)
          : undefined,
        authCredentialSalt: device.authCredentialSalt,
      },
      capabilities: device.capabilities,
      accessKey: device.accessKey,
      profileName: device.profileName,
      profileKeyCommitment: device.profileKeyCommitment
        ? Buffer.from(device.profileKeyCommitment.serialize())
        : undefined,
      keys: [...keys].map(([kind, value]) => {
        if (value.preKeyIterator || value.kyberPreKeyIterator) {
          throw new Error(
            'Demo persistence forbids simulated client key iterators'
          );
        }
        return [
          kind,
          {
            identityKey: Buffer.from(value.identityKey.serialize()),
            signedPreKey: encodeKey(value.signedPreKey),
            lastResortKey: encodeKey(value.lastResortKey),
            preKeys: value.preKeys.map(encodeKey),
            kyberPreKeys: value.kyberPreKeys.map(encodeKey),
          },
        ] as [ServiceIdKind, EncodedKeys];
      }),
    } as EncodedDevice;
  });
  const storage = fields.storageAuthByUsername as Map<
    string,
    { username: string; password: string; device: Device }
  >;
  const groups = fields.groups as Map<string, ServerGroup>;
  return {
    version: 1,
    devices,
    fields: Object.fromEntries(PLAIN_FIELDS.map(key => [key, fields[key]])),
    storageAuth: [...storage.values()].map(entry => ({
      ...entry,
      device: entry.device.debugId,
    })),
    groups: [...groups].map(([key, group]) => ({
      key,
      changes: Proto.GroupChanges.encode(group.changes),
    })),
  };
}

export async function importState(
  server: BaseServer,
  snapshot: Snapshot
): Promise<void> {
  if (snapshot.version !== 1) {
    throw new Error('Unsupported private backend state version');
  }
  const fields = privateFields(server);
  const devices = new Map<string, Device>();
  const byAci = fields.devices as Map<string, Device[]>;
  const primary = fields.primaryByServiceId as Map<string, Device>;
  for (const value of snapshot.devices) {
    const device = new Device(value.options);
    device.capabilities = value.capabilities;
    device.accessKey = value.accessKey;
    device.profileName = value.profileName;
    device.profileKeyCommitment = value.profileKeyCommitment
      ? new ProfileKeyCommitment(value.profileKeyCommitment)
      : undefined;
    for (const [kind, keys] of value.keys) {
      const ec = (key: EncodedKey) => ({
        ...key,
        publicKey: PublicKey.deserialize(key.publicKey),
      });
      const pq = (key: EncodedKey) => ({
        ...key,
        publicKey: KEMPublicKey.deserialize(key.publicKey),
      });
      await device.setKeys(kind, {
        identityKey: PublicKey.deserialize(keys.identityKey),
        signedPreKey: {
          ...ec(keys.signedPreKey),
          signature: keys.signedPreKey.signature!,
        },
        lastResortKey: {
          ...pq(keys.lastResortKey),
          signature: keys.lastResortKey.signature!,
        },
        preKeys: keys.preKeys.map(ec),
        kyberPreKeys: keys.kyberPreKeys.map(key => ({
          ...pq(key),
          signature: key.signature!,
        })),
      });
    }
    devices.set(device.debugId, device);
    byAci.set(device.aci, [...(byAci.get(device.aci) ?? []), device]);
    if (device.deviceId === 1) {
      primary.set(device.aci, device);
      if (device.pni) {
        primary.set(device.pni, device);
      }
    }
  }
  for (const key of PLAIN_FIELDS) {
    if (snapshot.fields[key] !== undefined) {
      fields[key] = snapshot.fields[key];
    }
  }
  const storageByUsername = fields.storageAuthByUsername as Map<
    string,
    unknown
  >;
  const storageByDevice = fields.storageAuthByDevice as Map<Device, unknown>;
  for (const entry of snapshot.storageAuth) {
    const device = devices.get(entry.device);
    if (!device) {
      throw new Error('Persisted storage credential has no device');
    }
    const restored = { ...entry, device };
    storageByUsername.set(entry.username, restored);
    storageByDevice.set(device, restored);
  }
  const groups = fields.groups as Map<string, ServerGroup>;
  const zkSecret = (
    server as unknown as {
      zkSecret: ConstructorParameters<typeof ServerZkProfileOperations>[0];
    }
  ).zkSecret;
  for (const entry of snapshot.groups) {
    const changes = Proto.GroupChanges.decode(entry.changes);
    const state = changes.groupChanges?.at(-1)?.groupState;
    if (!state) {
      throw new Error('Persisted group has no current state');
    }
    // The constructor expects new credential presentations. Persisted members
    // already have verified/unrolled ciphertexts, so hydrate only the pinned
    // instance fields and native verification parameters from our own database.
    const group = Object.create(ServerGroup.prototype) as ServerGroup;
    Object.assign(privateFields(group), {
      privChanges: changes,
      privPublicParams: new GroupPublicParams(Buffer.from(state.publicKey)),
      zkSecret,
      profileOps: new ServerZkProfileOperations(zkSecret),
    });
    groups.set(entry.key, group);
  }
}
