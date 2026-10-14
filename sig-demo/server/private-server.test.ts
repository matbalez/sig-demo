// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, X509Certificate } from 'node:crypto';
import { test } from 'node:test';
import {
  Aci,
  IdentityChange,
  IdentityKeyStore,
  KEMKeyPair,
  KyberPreKeyRecord,
  KyberPreKeyStore,
  PreKeyBundle,
  PreKeyRecord,
  PreKeySignalMessage,
  PreKeyStore,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  SessionRecord,
  SessionStore,
  SignedPreKeyRecord,
  SignedPreKeyStore,
  processPreKeyBundle,
  signalDecryptPreKey,
  signalEncrypt,
} from '@signalapp/libsignal-client';
import {
  ClientZkProfileOperations,
  ExpiringProfileKeyCredentialResponse,
  GroupSecretParams,
  ProfileKey,
  ServerPublicParams,
  GroupSendEndorsementsResponse,
  UuidCiphertext,
} from '@signalapp/libsignal-client/zkgroup';
import { Group as ClientGroup } from '@signalapp/mock-server/src/api/group';
import { EnvelopeType } from '@signalapp/mock-server/src/server/base';
import { ServiceIdKind } from '@signalapp/mock-server/src/types';
import type { AciString } from '@signalapp/mock-server/src/types';
import { signalservice as Proto } from '@signalapp/mock-server/protos/compiled';
import { initialize, loadConfig } from './main';
import { HttpError, PrivateServer } from './private-server';

class Sessions extends SessionStore {
  private readonly values = new Map<string, SessionRecord>();
  public async saveSession(
    address: ProtocolAddress,
    value: SessionRecord
  ): Promise<void> {
    this.values.set(address.toString(), value);
  }
  public async getSession(
    address: ProtocolAddress
  ): Promise<SessionRecord | null> {
    return this.values.get(address.toString()) ?? null;
  }
  public async getExistingSessions(
    addresses: ProtocolAddress[]
  ): Promise<SessionRecord[]> {
    return Promise.all(
      addresses.map(async address => {
        const value = await this.getSession(address);
        assert(value);
        return value;
      })
    );
  }
}
class Identity extends IdentityKeyStore {
  private readonly remote = new Map<string, PublicKey>();
  constructor(public readonly privateKey: PrivateKey) {
    super();
  }
  public async getIdentityKey(): Promise<PrivateKey> {
    return this.privateKey;
  }
  public async getLocalRegistrationId(): Promise<number> {
    return 123;
  }
  public async saveIdentity(
    address: ProtocolAddress,
    key: PublicKey
  ): Promise<IdentityChange> {
    this.remote.set(address.toString(), key);
    return IdentityChange.NewOrUnchanged;
  }
  public async isTrustedIdentity(): Promise<boolean> {
    return true;
  }
  public async getIdentity(
    address: ProtocolAddress
  ): Promise<PublicKey | null> {
    return this.remote.get(address.toString()) ?? null;
  }
}
class EmptyPreKeys extends PreKeyStore {
  public async savePreKey(): Promise<void> {
    throw new Error('Unexpected one-time prekey');
  }
  public async getPreKey(): Promise<PreKeyRecord> {
    throw new Error('Unexpected one-time prekey');
  }
  public async removePreKey(): Promise<void> {
    throw new Error('Unexpected one-time prekey');
  }
}
class SignedKeys extends SignedPreKeyStore {
  constructor(private readonly record: SignedPreKeyRecord) {
    super();
  }
  public async saveSignedPreKey(): Promise<void> {
    throw new Error('Unexpected signed key write');
  }
  public async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    assert.equal(id, this.record.id());
    return this.record;
  }
}
class KyberKeys extends KyberPreKeyStore {
  constructor(private readonly record: KyberPreKeyRecord) {
    super();
  }
  public async saveKyberPreKey(): Promise<void> {
    throw new Error('Unexpected Kyber key write');
  }
  public async getKyberPreKey(id: number): Promise<KyberPreKeyRecord> {
    assert.equal(id, this.record.id());
    return this.record;
  }
  public async markKyberPreKeyUsed(): Promise<void> {
    /* Last-resort public prekey remains available. */
  }
}

function client(name: string, inviteCode: string) {
  const identity = PrivateKey.generate();
  const signed = PrivateKey.generate();
  const kem = KEMKeyPair.generate();
  const signedSignature = identity.sign(signed.getPublicKey().serialize());
  const pqSignature = identity.sign(kem.getPublicKey().serialize());
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  const publicEC = {
    keyId: 1,
    publicKey: b64(signed.getPublicKey().serialize()),
    signature: b64(signedSignature),
  };
  const publicPQ = {
    keyId: 1,
    publicKey: b64(kem.getPublicKey().serialize()),
    signature: b64(pqSignature),
  };
  const password = randomBytes(32).toString('base64');
  return {
    identity: new Identity(identity),
    sessions: new Sessions(),
    signedKeys: new SignedKeys(
      SignedPreKeyRecord.new(
        1,
        Date.now(),
        signed.getPublicKey(),
        signed,
        signedSignature
      )
    ),
    kyberKeys: new KyberKeys(
      KyberPreKeyRecord.new(1, Date.now(), kem, pqSignature)
    ),
    body: {
      inviteCode,
      displayName: name,
      password,
      sessionId: '',
      skipDeviceTransfer: true,
      accountAttributes: {
        fetchesMessages: true,
        registrationId: 123,
        pniRegistrationId: 124,
        capabilities: {
          attachmentBackfill: true,
          spqr: true,
          usernameChangeSyncMessage: true,
          optionalPhoneNumber: true,
        },
        unidentifiedAccessKey: [...randomBytes(16)],
        unrestrictedUnidentifiedAccess: false,
        discoverableByPhoneNumber: false,
        recoveryPassword: randomBytes(32).toString('base64'),
      },
      aciIdentityKey: b64(identity.getPublicKey().serialize()),
      pniIdentityKey: b64(identity.getPublicKey().serialize()),
      aciSignedPreKey: publicEC,
      pniSignedPreKey: publicEC,
      aciPqLastResortPreKey: publicPQ,
      pniPqLastResortPreKey: publicPQ,
    },
  };
}

test(
  'invite admission, real libsignal encrypted offline delivery, and encrypted group state survive a backend restart',
  { timeout: 20000 },
  async () => {
    const dataDir = mkdtempSync(
      path.join(os.tmpdir(), 'sig-demo-private-test-')
    );
    let server: PrivateServer | undefined;
    try {
      initialize(dataDir, 8443);
      const config = loadConfig(dataDir);
      server = new PrivateServer(config, path.join(dataDir, 'demo.sqlite'));
      const alice = client('Alice', server.store.createInvite());
      const bob = client('Bob', server.store.createInvite());
      await assert.rejects(
        server.registerInvite({
          ...alice.body,
          inviteCode: 'invalid-token-long-enough',
        }),
        (error: unknown) => error instanceof HttpError && error.status === 403
      );
      const altered = {
        ...alice.body,
        aciSignedPreKey: {
          ...alice.body.aciSignedPreKey,
          signature: randomBytes(64).toString('base64'),
        },
      };
      await assert.rejects(
        server.registerInvite(altered),
        (error: unknown) => error instanceof HttpError && error.status === 400
      );
      const aliceAccount = (await server.registerInvite(alice.body)) as {
        uuid: string;
        number: string;
      };
      const bobAccount = (await server.registerInvite(bob.body)) as {
        uuid: string;
      };
      assert.match(aliceAccount.number, /^\+999\d{9}$/);
      assert.deepEqual(await server.registerInvite(alice.body), aliceAccount);
      await assert.rejects(
        server.registerInvite({
          ...alice.body,
          password: randomBytes(32).toString('base64'),
        }),
        (error: unknown) => error instanceof HttpError && error.status === 409
      );
      assert.equal(
        await server.auth(`${aliceAccount.uuid}.1`, 'incorrect'),
        undefined
      );
      const aliceDevice = await server.auth(
        `${aliceAccount.uuid}.1`,
        alice.body.password
      );
      const bobDevice = await server.auth(
        `${bobAccount.uuid}.1`,
        bob.body.password
      );
      assert(aliceDevice && bobDevice);
      const storageAuth = await server.getStorageAuth(aliceDevice);
      assert.equal(
        await server.storageAuth(storageAuth.username, 'wrong'),
        undefined
      );

      const aliceAddress = ProtocolAddress.new(aliceAccount.uuid, 1);
      const bobAddress = ProtocolAddress.new(bobAccount.uuid, 1);
      const bundle = await bobDevice.popSingleUseKey();
      await processPreKeyBundle(
        PreKeyBundle.new(
          123,
          1,
          null,
          null,
          bundle.signedPreKey.keyId,
          bundle.signedPreKey.publicKey,
          bundle.signedPreKey.signature,
          bundle.identityKey,
          bundle.pqPreKey.keyId,
          bundle.pqPreKey.publicKey,
          bundle.pqPreKey.signature
        ),
        bobAddress,
        aliceAddress,
        alice.sessions,
        alice.identity
      );
      const plaintext = Buffer.from(
        'This private message must never appear in backend storage.'
      );
      const encrypted = await signalEncrypt(
        plaintext,
        bobAddress,
        aliceAddress,
        alice.sessions,
        alice.identity
      );
      await server.handleMessage(
        aliceDevice,
        ServiceIdKind.ACI,
        EnvelopeType.PreKey,
        bobDevice,
        Buffer.from(encrypted.serialize()),
        BigInt(Date.now())
      );
      assert.equal(
        Number(
          server.store.db.prepare('SELECT COUNT(*) AS count FROM inbox').get()
            ?.count
        ),
        1
      );
      const stored = server.store.firstPending(bobDevice.debugId);
      assert(stored && !stored.envelope.includes(plaintext));

      const groupSecret = GroupSecretParams.generate();
      const clientZk = new ClientZkProfileOperations(
        new ServerPublicParams(
          Buffer.from(config.zkParams!.publicParams, 'base64')
        )
      );
      const members = [];
      for (const device of [aliceDevice, bobDevice]) {
        const aci = Aci.parseFromServiceIdString(device.aci);
        const profileKey = new ProfileKey(randomBytes(32));
        device.profileKeyCommitment = profileKey.getCommitment(aci);
        const context = clientZk.createProfileKeyCredentialRequestContext(
          aci,
          profileKey
        );
        const response = await server.issueExpiringProfileKeyCredential(
          device,
          context.getRequest()
        );
        assert(response);
        const credential = clientZk.receiveExpiringProfileKeyCredential(
          context,
          new ExpiringProfileKeyCredentialResponse(response)
        );
        members.push({
          aci: device.aci as AciString,
          profileKey,
          presentation: clientZk.createExpiringProfileKeyCredentialPresentation(
            groupSecret,
            credential
          ),
        });
      }
      const group = ClientGroup.fromConfig({
        secretParams: groupSecret,
        title: 'Encrypted private group title',
        members,
      });
      const createdGroup = await server.createGroup(group.state);
      const endorsementBytes = createdGroup.getGroupSendEndorsementResponse(
        new UuidCiphertext(group.encryptServiceId(aliceDevice.aci))
      );
      assert(endorsementBytes);
      const endorsement = new GroupSendEndorsementsResponse(endorsementBytes);
      const received = endorsement.receiveWithServiceIds(
        [
          Aci.parseFromServiceIdString(aliceDevice.aci),
          Aci.parseFromServiceIdString(bobDevice.aci),
        ],
        Aci.parseFromServiceIdString(aliceDevice.aci),
        groupSecret,
        new ServerPublicParams(
          Buffer.from(config.zkParams!.publicParams, 'base64')
        )
      );
      const token = received.combinedEndorsement.toFullToken(
        groupSecret,
        endorsement.getExpiration()
      );
      server.verifyGroupSendToken(Buffer.from(token.serialize()), [
        bobDevice.aci,
      ]);
      assert.throws(() =>
        server!.verifyGroupSendToken(randomBytes(100), [bobDevice.aci])
      );
      server.persist();
      const snapshot = Buffer.from(
        server.store.db.prepare('SELECT payload FROM state WHERE id=1').get()!
          .payload as Uint8Array
      );
      assert(!snapshot.includes(plaintext));
      assert(!snapshot.includes(Buffer.from('Encrypted private group title')));
      assert(
        !snapshot.includes(Buffer.from(alice.identity.privateKey.serialize()))
      );
      await server.shutdown();
      server = new PrivateServer(config, path.join(dataDir, 'demo.sqlite'));
      await server.restore();
      assert.deepEqual(await server.registerInvite(alice.body), aliceAccount);
      const restoredBob = await server.auth(
        `${bobAccount.uuid}.1`,
        bob.body.password
      );
      assert(restoredBob);
      const restoredGroup = await server.getGroup(
        group.publicParams.serialize()
      );
      assert(restoredGroup && restoredGroup.state.members?.length === 2);
      assert.equal(
        new ClientGroup({
          secretParams: groupSecret,
          groupState: restoredGroup.state,
        }).title,
        'Encrypted private group title'
      );
      assert.equal(
        await server.storageAuth(storageAuth.username, 'wrong'),
        undefined
      );
      assert(
        await server.storageAuth(storageAuth.username, storageAuth.password)
      );

      let deliver!: (envelope: Buffer<ArrayBuffer>) => void;
      const delivered = new Promise<Buffer<ArrayBuffer>>(resolve => {
        deliver = resolve;
      });
      await server.addWebSocket(restoredBob, {
        async sendMessage(envelope) {
          if (envelope !== 'empty') {
            deliver(envelope);
          }
        },
        close() {},
      });
      const envelope = Proto.Envelope.decode(await delivered);
      assert(envelope.content);
      const decrypted = await signalDecryptPreKey(
        PreKeySignalMessage.deserialize(Buffer.from(envelope.content)),
        aliceAddress,
        bobAddress,
        bob.sessions,
        bob.identity,
        new EmptyPreKeys(),
        bob.signedKeys,
        bob.kyberKeys
      );
      assert.deepEqual(Buffer.from(decrypted), plaintext);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(server.store.firstPending(restoredBob.debugId), undefined);
      await server.shutdown();
      server = undefined;
    } finally {
      if (server) {
        await server.shutdown();
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
);

test(
  'private HTTPS/HTTP2 endpoints and the actual Desktop libsignal transport enforce admission and deliver primary inboxes',
  { timeout: 20000 },
  async () => {
    const dataDir = mkdtempSync(
      path.join(os.tmpdir(), 'sig-demo-transport-test-')
    );
    let server: PrivateServer | undefined;
    let session: http2.ClientHttp2Session | undefined;
    let nativeChat: { disconnect(): Promise<void> } | undefined;
    let nativeBob: { disconnect(): Promise<void> } | undefined;
    let nativeAnonymous: { disconnect(): Promise<void> } | undefined;
    try {
      initialize(dataDir, 8443);
      const config = loadConfig(dataDir);
      server = new PrivateServer(
        { ...config, clientPort: undefined },
        path.join(dataDir, 'demo.sqlite')
      );
      await server.listen(0);
      const port = server.address().port;
      const ca = readFileSync(path.join(dataDir, 'ca-cert.pem'));
      session = http2.connect(`https://127.0.0.1:${port}`, { ca });
      const request = (
        method: string,
        requestPath: string,
        data?: unknown,
        headers: Record<string, string> = {}
      ) =>
        new Promise<{
          status: number;
          body: Buffer;
          trailers: http2.IncomingHttpHeaders;
        }>((resolve, reject) => {
          const stream = session!.request({
            ':method': method,
            ':path': requestPath,
            ...headers,
          });
          const chunks: Buffer[] = [];
          let status = 0;
          let trailers: http2.IncomingHttpHeaders = {};
          stream.on('response', response => {
            status = Number(response[':status']);
          });
          stream.on('trailers', value => {
            trailers = value;
          });
          stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
          stream.on('error', reject);
          stream.on('end', () =>
            resolve({ status, body: Buffer.concat(chunks), trailers })
          );
          stream.end(
            data === undefined
              ? undefined
              : Buffer.isBuffer(data)
                ? data
                : JSON.stringify(data)
          );
        });
      assert.equal((await request('GET', '/health')).status, 200);
      assert.equal(
        (await request('GET', '/cdn3/../server-secrets.json')).status,
        403
      );
      assert.equal(
        (await request('GET', '/updates2/../../server-secrets.json')).status,
        403
      );
      assert.equal(
        (await request('GET', '/cdn3/%252e%252e/server-secrets.json')).status,
        403
      );
      const alice = client('Transport Alice', server.store.createInvite());
      const registration = await request(
        'POST',
        '/v1/sig-demo/accounts',
        alice.body,
        { 'content-type': 'application/json' }
      );
      assert.equal(registration.status, 200);
      const account = JSON.parse(registration.body.toString()) as {
        uuid: string;
      };
      assert.equal(
        (await request('GET', '/v1/sig-demo/directory')).status,
        401
      );
      const roster = await request('GET', '/v1/sig-demo/directory', undefined, {
        authorization: `Basic ${Buffer.from(`${account.uuid}.1:${alice.body.password}`).toString('base64')}`,
      });
      assert.deepEqual(JSON.parse(roster.body.toString()), {
        accounts: [{ uuid: account.uuid, displayName: 'Transport Alice' }],
      });
      const emptyFrame = Buffer.alloc(5);
      const forged = await request(
        'POST',
        '/org.signal.chat.messages.MessagesAnonymous/SendMultiRecipientMessage',
        emptyFrame,
        { 'content-type': 'application/grpc' }
      );
      assert.equal(forged.trailers['grpc-status'], '16');
      process.stdout.write(
        'Transport checks: HTTPS admission, directory, path confinement, and forged multicast rejection passed.\n'
      );

      // Resolve the exact libsignal version used by Desktop, independently of the
      // backend's pinned libsignal version. Native handles never cross this boundary.
      const desktopRequire = createRequire(
        path.resolve(__dirname, '../../package.json')
      );
      const DesktopLib = desktopRequire(
        '@signalapp/libsignal-client'
      ) as typeof import('../../node_modules/@signalapp/libsignal-client/dist/index');
      const DesktopNet = DesktopLib.Net;
      const net = new DesktopNet.Net({
        localTestServer: true,
        userAgent: 'SigDemo Transport Test',
        TESTING_localServer_chatPort: port,
        TESTING_localServer_cdsiPort: 9,
        TESTING_localServer_svr2Port: 9,
        TESTING_localServer_svrBPort: 9,
        TESTING_localServer_rootCertificateDer: new X509Certificate(ca).raw,
        TESTING_localServer_httpVersion: 2,
      });
      let deliver!: (bytes: Uint8Array<ArrayBuffer>) => void;
      const delivery = new Promise<Uint8Array<ArrayBuffer>>(resolve => {
        deliver = resolve;
      });
      const chat = await net.connectAuthenticatedChat(
        `${account.uuid}.1`,
        alice.body.password,
        false,
        {
          onIncomingMessage(bytes, _timestamp, ack) {
            ack.send(200);
            deliver(bytes);
          },
          onQueueEmpty() {},
          onConnectionInterrupted() {},
        },
        { abortSignal: AbortSignal.timeout(5000) }
      );
      nativeChat = chat;
      const remoteConfig = await chat.fetch({
        verb: 'GET',
        path: '/v2/config',
        headers: [],
        timeoutMillis: 3000,
      });
      const configJSON = JSON.parse(
        Buffer.from(remoteConfig.body!).toString()
      ) as { config: Record<string, string> };
      assert.equal(configJSON.config['global.groupsv2.maxGroupSize'], '32');
      assert.equal(
        configJSON.config['global.groupsv2.groupSizeHardLimit'],
        '64'
      );
      process.stdout.write(
        'Transport checks: native Desktop libsignal authenticated connection established.\n'
      );
      assert.equal(
        (
          await chat.fetch({
            verb: 'GET',
            path: '/v1/accounts/whoami',
            headers: [],
            timeoutMillis: 3000,
          })
        ).status,
        200
      );
      assert.equal(
        (
          await chat.fetch({
            verb: 'POST',
            path: '/v1/registration',
            headers: [],
            body: Buffer.from('{}'),
            timeoutMillis: 3000,
          })
        ).status,
        403
      );
      const profileKey = new ProfileKey(randomBytes(32));
      const ownAci = Aci.parseFromServiceIdString(account.uuid);
      const profileUpload = {
        commitment: Buffer.from(
          profileKey.getCommitment(ownAci).serialize()
        ).toString('base64'),
        version: 'demo-test-version',
        name: randomBytes(53).toString('base64'),
        avatar: false,
        sameAvatar: false,
      };
      assert.equal(
        (
          await chat.fetch({
            verb: 'PUT',
            path: '/v1/profile',
            headers: [],
            body: Buffer.from(JSON.stringify(profileUpload)),
            timeoutMillis: 3000,
          })
        ).status,
        200
      );
      const clientProfiles = new ClientZkProfileOperations(
        new ServerPublicParams(
          Buffer.from(config.zkParams!.publicParams, 'base64')
        )
      );
      const profileContext =
        clientProfiles.createProfileKeyCredentialRequestContext(
          ownAci,
          profileKey
        );
      const profileResponse = await chat.fetch({
        verb: 'GET',
        path: `/v1/profile/${account.uuid}/demo-test-version/${Buffer.from(profileContext.getRequest().serialize()).toString('hex')}?credentialType=expiringProfileKey`,
        headers: [],
        timeoutMillis: 3000,
      });
      assert.equal(profileResponse.status, 200);
      const profileJSON = JSON.parse(
        Buffer.from(profileResponse.body!).toString()
      ) as { credential: string };
      assert(
        clientProfiles.receiveExpiringProfileKeyCredential(
          profileContext,
          new ExpiringProfileKeyCredentialResponse(
            Buffer.from(profileJSON.credential, 'base64')
          )
        )
      );
      const form = await chat.getUploadForm({ uploadSize: 64n });
      process.stdout.write(
        'Transport checks: native websocket requests and gRPC upload form passed.\n'
      );
      assert.equal(form.signedUploadUrl.port, String(port));
      assert(form.headers.get('X-Sig-Demo-Upload'));
      assert.equal(
        (await request('HEAD', form.signedUploadUrl.pathname)).status,
        403
      );
      const device = await server.auth(
        `${account.uuid}.1`,
        alice.body.password
      );
      assert(device);
      const transportCiphertext = randomBytes(64);
      await server.handleMessage(
        device,
        ServiceIdKind.ACI,
        EnvelopeType.PreKey,
        device,
        transportCiphertext,
        BigInt(Date.now())
      );
      const received = await Promise.race([
        delivery,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Native inbox delivery timed out')),
            5000
          );
          timer.unref();
        }),
      ]);
      assert.deepEqual(
        Buffer.from(Proto.Envelope.decode(received).content!),
        transportCiphertext
      );

      // Exercise the exact typed send APIs used by the UI, using cryptographic
      // handles from Desktop's libsignal version rather than server test hooks.
      const bob = client('Transport Bob', server.store.createInvite());
      const bobRegistration = await request(
        'POST',
        '/v1/sig-demo/accounts',
        bob.body,
        { 'content-type': 'application/json' }
      );
      assert.equal(bobRegistration.status, 200);
      const bobAccount = JSON.parse(bobRegistration.body.toString()) as {
        uuid: string;
      };
      const bobDevice = await server.auth(
        `${bobAccount.uuid}.1`,
        bob.body.password
      );
      assert(bobDevice);
      let receiveBob!: (bytes: Uint8Array<ArrayBuffer>) => void;
      const nextBob = () =>
        new Promise<Uint8Array<ArrayBuffer>>(resolve => {
          receiveBob = resolve;
        });
      let bobDelivery = nextBob();
      const bobChat = await net.connectAuthenticatedChat(
        `${bobAccount.uuid}.1`,
        bob.body.password,
        false,
        {
          onIncomingMessage(bytes, _time, ack) {
            ack.send(200);
            receiveBob(bytes);
          },
          onQueueEmpty() {},
          onConnectionInterrupted() {},
        },
        { abortSignal: AbortSignal.timeout(5000) }
      );
      nativeBob = bobChat;
      const cryptoStores = (peer: ReturnType<typeof client>) => {
        const privateKey = DesktopLib.PrivateKey.deserialize(
          peer.identity.privateKey.serialize()
        );
        const identities = new Map<
          string,
          ReturnType<typeof DesktopLib.PublicKey.deserialize>
        >();
        const sessions = new Map<
          string,
          ReturnType<typeof DesktopLib.SessionRecord.deserialize>
        >();
        return {
          identity: {
            async getIdentityKey() {
              return privateKey;
            },
            async getIdentityKeyPair() {
              return new DesktopLib.IdentityKeyPair(
                privateKey.getPublicKey(),
                privateKey
              );
            },
            async getLocalRegistrationId() {
              return 123;
            },
            async saveIdentity(
              address: ReturnType<typeof DesktopLib.ProtocolAddress.new>,
              key: ReturnType<typeof DesktopLib.PublicKey.deserialize>
            ) {
              identities.set(address.toString(), key);
              return DesktopLib.IdentityChange.NewOrUnchanged;
            },
            async isTrustedIdentity() {
              return true;
            },
            async getIdentity(
              address: ReturnType<typeof DesktopLib.ProtocolAddress.new>
            ) {
              return identities.get(address.toString()) ?? null;
            },
          },
          sessions: {
            async saveSession(
              address: ReturnType<typeof DesktopLib.ProtocolAddress.new>,
              record: ReturnType<typeof DesktopLib.SessionRecord.deserialize>
            ) {
              sessions.set(address.toString(), record);
            },
            async getSession(
              address: ReturnType<typeof DesktopLib.ProtocolAddress.new>
            ) {
              return sessions.get(address.toString()) ?? null;
            },
            async getExistingSessions(
              addresses: Array<
                ReturnType<typeof DesktopLib.ProtocolAddress.new>
              >
            ) {
              return addresses.map(address => {
                const value = sessions.get(address.toString());
                assert(value);
                return value;
              });
            },
          },
        };
      };
      const aliceCrypto = cryptoStores(alice);
      const bobCrypto = cryptoStores(bob);
      const aliceAddress = DesktopLib.ProtocolAddress.new(account.uuid, 1);
      const bobAddress = DesktopLib.ProtocolAddress.new(bobAccount.uuid, 1);
      const bundle = await bobDevice.popSingleUseKey();
      await DesktopLib.processPreKeyBundle(
        DesktopLib.PreKeyBundle.new(
          123,
          1,
          null,
          null,
          bundle.signedPreKey.keyId,
          DesktopLib.PublicKey.deserialize(
            bundle.signedPreKey.publicKey.serialize()
          ),
          bundle.signedPreKey.signature,
          DesktopLib.PublicKey.deserialize(bundle.identityKey.serialize()),
          bundle.pqPreKey.keyId,
          DesktopLib.KEMPublicKey.deserialize(
            bundle.pqPreKey.publicKey.serialize()
          ),
          bundle.pqPreKey.signature
        ),
        bobAddress,
        aliceAddress,
        aliceCrypto.sessions,
        aliceCrypto.identity
      );
      const signedRecord = DesktopLib.SignedPreKeyRecord.deserialize(
        (await bob.signedKeys.getSignedPreKey(1)).serialize()
      );
      const kyberRecord = DesktopLib.KyberPreKeyRecord.deserialize(
        (await bob.kyberKeys.getKyberPreKey(1)).serialize()
      );
      const bobSigned = {
        async saveSignedPreKey() {},
        async getSignedPreKey() {
          return signedRecord;
        },
      };
      const bobKyber = {
        async saveKyberPreKey() {},
        async getKyberPreKey() {
          return kyberRecord;
        },
        async markKyberPreKeyUsed() {},
      };
      const bobPreKeys = {
        async savePreKey() {},
        async removePreKey() {},
        async getPreKey(): Promise<
          ReturnType<typeof DesktopLib.PreKeyRecord.deserialize>
        > {
          throw new Error('Unexpected one-time prekey');
        },
      };
      const authenticatedText = Buffer.from(
        'Actual UI typed authenticated send'
      );
      const authenticatedCipher = await DesktopLib.signalEncrypt(
        authenticatedText,
        bobAddress,
        aliceAddress,
        aliceCrypto.sessions,
        aliceCrypto.identity
      );
      await chat.sendMessage({
        destination: DesktopLib.Aci.fromUuid(bobAccount.uuid),
        timestamp: Date.now(),
        contents: [
          { deviceId: 1, registrationId: 123, contents: authenticatedCipher },
        ],
        onlineOnly: false,
        urgent: true,
      });
      const authEnvelope = Proto.Envelope.decode(await bobDelivery);
      assert.deepEqual(
        Buffer.from(
          await DesktopLib.signalDecryptPreKey(
            DesktopLib.PreKeySignalMessage.deserialize(
              Buffer.from(authEnvelope.content!)
            ),
            aliceAddress,
            bobAddress,
            bobCrypto.sessions,
            bobCrypto.identity,
            bobPreKeys,
            bobSigned,
            bobKyber
          )
        ),
        authenticatedText
      );
      bobDelivery = nextBob();
      const sealedText = Buffer.from(
        'Actual UI typed sealed sender/profile sharing route'
      );
      const sealedCipher = await DesktopLib.signalEncrypt(
        sealedText,
        bobAddress,
        aliceAddress,
        aliceCrypto.sessions,
        aliceCrypto.identity
      );
      const senderCertificate = DesktopLib.SenderCertificate.deserialize(
        (await server.getSenderCertificate(device)).serialize()
      );
      const sealedContent = DesktopLib.UnidentifiedSenderMessageContent.new(
        sealedCipher,
        senderCertificate,
        0,
        null
      );
      const sealedPayload = await DesktopLib.sealedSenderEncrypt(
        sealedContent,
        bobAddress,
        aliceCrypto.identity
      );
      const anonymous = await net.connectUnauthenticatedChat(
        { onConnectionInterrupted() {} },
        { abortSignal: AbortSignal.timeout(5000) }
      );
      nativeAnonymous = anonymous;
      await anonymous.sendMessage({
        destination: DesktopLib.Aci.fromUuid(bobAccount.uuid),
        timestamp: Date.now(),
        contents: [
          { deviceId: 1, registrationId: 123, contents: sealedPayload },
        ],
        auth: { accessKey: bobDevice.accessKey! },
        onlineOnly: false,
        urgent: true,
      });
      const sealedEnvelope = Proto.Envelope.decode(await bobDelivery);
      const usmc = await DesktopLib.sealedSenderDecryptToUsmc(
        Buffer.from(sealedEnvelope.content!),
        bobCrypto.identity
      );
      const sealedPlaintext =
        usmc.msgType() === DesktopLib.CiphertextMessageType.PreKey
          ? await DesktopLib.signalDecryptPreKey(
              DesktopLib.PreKeySignalMessage.deserialize(usmc.contents()),
              aliceAddress,
              bobAddress,
              bobCrypto.sessions,
              bobCrypto.identity,
              bobPreKeys,
              bobSigned,
              bobKyber
            )
          : await DesktopLib.signalDecrypt(
              DesktopLib.SignalMessage.deserialize(usmc.contents()),
              aliceAddress,
              bobAddress,
              bobCrypto.sessions,
              bobCrypto.identity
            );
      assert.deepEqual(Buffer.from(sealedPlaintext), sealedText);
      process.stdout.write(
        'Transport checks: actual Desktop typed authenticated and sealed sends decrypted by the recipient.\n'
      );
      await anonymous.disconnect();
      nativeAnonymous = undefined;
      await bobChat.disconnect();
      nativeBob = undefined;
      await chat.disconnect();
      nativeChat = undefined;
      session.close();
      session = undefined;
      await server.shutdown();
      server = undefined;
    } finally {
      if (nativeAnonymous) {
        await nativeAnonymous.disconnect();
      }
      if (nativeBob) {
        await nativeBob.disconnect();
      }
      if (nativeChat) {
        await nativeChat.disconnect();
      }
      session?.destroy();
      if (server) {
        await server.shutdown();
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
