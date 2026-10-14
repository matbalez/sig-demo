// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import {
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import http2, {
  type Http2ServerRequest,
  type Http2ServerResponse,
} from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  KEMPublicKey,
  PublicKey,
  ServiceId,
} from '@signalapp/libsignal-client';
import SealedSenderMultiRecipientMessage from '@signalapp/libsignal-client/dist/SealedSenderMultiRecipientMessage';
import {
  GroupSendDerivedKeyPair,
  GroupSendFullToken,
  ProfileKeyCommitment,
} from '@signalapp/libsignal-client/zkgroup';
import WebSocket from 'ws';
import { buffer, run } from 'micro';

import { Server, type Config } from '@signalapp/mock-server/src/api/server';
import {
  Device,
  type DeviceKeys,
} from '@signalapp/mock-server/src/data/device';
import {
  RegisterAccountSchema,
  UpdateProfileSchema,
} from '@signalapp/mock-server/src/data/schemas';
import { createHandler as createHTTPHandler } from '@signalapp/mock-server/src/server/http';
import { createHandler as createGRPCHandler } from '@signalapp/mock-server/src/server/grpc';
import { Connection } from '@signalapp/mock-server/src/server/ws/connection';
import type {
  WSRequest,
  WSResponse,
} from '@signalapp/mock-server/src/server/ws/service';
import {
  EnvelopeType,
  type AttachmentUploadForm,
} from '@signalapp/mock-server/src/server/base';
import type {
  AciString,
  RegistrationId,
  ServiceIdString,
} from '@signalapp/mock-server/src/types';
import { ServiceIdKind } from '@signalapp/mock-server/src/types';
import {
  org,
  signalservice as Proto,
} from '@signalapp/mock-server/protos/compiled';
import { allDevices, exportState, importState, type Snapshot } from './state';
import { canonicalJSON, DemoStore, hashText } from './store';
import { handlePrivateGRPC } from './grpc';

type DeliverySocket = {
  sendMessage(message: Buffer<ArrayBuffer> | 'empty'): Promise<void>;
  close(code: number): void;
};
type Registration = ReturnType<typeof RegisterAccountSchema.parse>;
type PublicSignedKey = Registration['aciSignedPreKey'];
export type PrivateServerConfig = Config & {
  clientPort?: number;
  allowPublicListen?: boolean;
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

class PrivateConnection extends Connection {
  constructor(
    request: Http2ServerRequest,
    socket: WebSocket,
    privateServer: PrivateServer
  ) {
    super(request, socket, privateServer);
    this.privateServer = privateServer;
  }
  private readonly privateServer: PrivateServer;

  protected override async handleRequest(
    request: WSRequest
  ): Promise<WSResponse> {
    // The test server's registration, phone changes, and linking flows are forbidden.
    // New clients must redeem a one-time invite through the private HTTP endpoint.
    if (
      request.path?.startsWith('/v1/registration') ||
      request.path?.startsWith('/v1/verification/') ||
      request.path?.startsWith('/v1/devices/link') ||
      request.path?.includes('change_number')
    ) {
      return {
        id: request.id ?? null,
        status: 403,
        message: 'Use private demo invite registration',
        body: null,
        headers: null,
      };
    }
    if (
      request.path?.includes('backup') ||
      request.path?.includes('/archives/') ||
      request.path?.includes('calling') ||
      request.path?.includes('call-link')
    ) {
      return {
        id: request.id ?? null,
        status: 404,
        message: 'Feature unavailable in private demo',
        body: null,
        headers: null,
      };
    }
    if (request.verb === 'PUT' && request.path?.startsWith('/v1/messages/')) {
      const headers = Object.fromEntries(
        (request.headers ?? []).map(header => {
          const index = header.indexOf(':');
          return [
            header.slice(0, index).toLowerCase(),
            header.slice(index + 1).trim(),
          ];
        })
      );
      const requestPath = new URL(request.path, 'https://localhost');
      if (requestPath.searchParams.get('story') === 'true') {
        return {
          id: request.id ?? null,
          status: 403,
          message: 'Stories unavailable in private demo',
          body: null,
          headers: null,
        };
      }
      if (headers['group-send-token']) {
        const destination = decodeURIComponent(
          requestPath.pathname.slice('/v1/messages/'.length)
        );
        try {
          this.privateServer.verifyGroupSendToken(
            Buffer.from(headers['group-send-token'], 'base64'),
            [destination]
          );
        } catch {
          return {
            id: request.id ?? null,
            status: 401,
            message: 'Invalid group send authorization',
            body: null,
            headers: null,
          };
        }
      }
    }
    const result = await super.handleRequest(request);
    if (
      result.status === 200 &&
      request.verb === 'PUT' &&
      request.path === '/v1/profile' &&
      request.body
    ) {
      // The upstream mock saves the encrypted name but drops this public
      // commitment. Real desktop clients need it to obtain group credentials.
      const profile = UpdateProfileSchema.parse(
        JSON.parse(Buffer.from(request.body).toString())
      );
      const device = (this as unknown as { device?: Device }).device;
      if (device) {
        device.profileKeyCommitment = new ProfileKeyCommitment(
          Buffer.from(profile.commitment, 'base64')
        );
      }
    }
    this.privateServer.persist();
    return result;
  }
}

export class PrivateServer extends Server {
  public readonly store: DemoStore;
  private readonly privateConfig: PrivateServerConfig;
  private readonly connected = new Map<string, DeliverySocket>();
  private readonly httpSessions = new Set<http2.ServerHttp2Session>();
  private readonly draining = new Set<string>();
  private registrationTail: Promise<unknown> = Promise.resolve();

  constructor(config: PrivateServerConfig, databasePath: string) {
    if (
      !config.trustRoot ||
      !config.zkParams ||
      !config.https?.cert ||
      !config.https?.key
    ) {
      throw new Error(
        'Private server requires its own TLS certificate and libsignal server keys'
      );
    }
    super(config);
    this.privateConfig = config;
    this.store = new DemoStore(databasePath);
    this.setDemoRemoteConfig();
  }

  public async restore(): Promise<void> {
    const snapshot = this.store.loadState() as Snapshot | undefined;
    if (snapshot) {
      await importState(this, snapshot);
    }
    this.setDemoRemoteConfig();
  }

  private setDemoRemoteConfig(): void {
    this.setRemoteConfig('global.groupsv2.maxGroupSize', {
      enabled: true,
      value: '32',
    });
    this.setRemoteConfig('global.groupsv2.groupSizeHardLimit', {
      enabled: true,
      value: '64',
    });
    this.setRemoteConfig('global.pinnedChatLimit', {
      enabled: true,
      value: '4',
    });
  }

  public persist(): void {
    this.store.saveState(exportState(this));
  }

  public verifyGroupSendToken(
    bytes: Buffer<ArrayBuffer>,
    recipients: string[]
  ): void {
    const token = new GroupSendFullToken(bytes);
    const expiration = token.getExpiration();
    const until = expiration.getTime() - Date.now();
    if (until <= 0 || until > 8 * 86400000) {
      throw new Error('Invalid group token expiration');
    }
    token.verify(
      recipients.map(value => ServiceId.parseFromServiceIdString(value)),
      GroupSendDerivedKeyPair.forExpiration(expiration, this.zkSecret)
    );
  }

  public override async auth(
    username: string,
    password: string
  ): Promise<Device | undefined> {
    if (!this.store.verifyCredential(username, password)) {
      return undefined;
    }
    return allDevices(this).find(device => device.debugId === username);
  }

  public override async storageAuth(
    username: string,
    password: string
  ): Promise<Device | undefined> {
    // Upstream mock storageAuth returns a device even on an incorrect password.
    const map = (
      this as unknown as {
        storageAuthByUsername: Map<
          string,
          { password: string; device: Device }
        >;
      }
    ).storageAuthByUsername;
    const entry = map.get(username);
    if (!entry) {
      return undefined;
    }
    const expected = Buffer.from(entry.password);
    const actual = Buffer.from(password);
    return expected.length === actual.length &&
      timingSafeEqual(expected, actual)
      ? entry.device
      : undefined;
  }

  public registerInvite(body: unknown): Promise<unknown> {
    // Serialize invite redemption so retries cannot create a second device/account.
    const result = this.registrationTail.then(() =>
      this.registerInviteNow(body)
    );
    this.registrationTail = result.catch(() => undefined);
    return result;
  }

  private async registerInviteNow(body: unknown): Promise<unknown> {
    if (!body || typeof body !== 'object') {
      throw new HttpError(400, 'Expected a registration object');
    }
    const input = body as Record<string, unknown>;
    const { inviteCode, password, displayName } = input;
    if (
      typeof inviteCode !== 'string' ||
      inviteCode.length < 20 ||
      inviteCode.length > 128 ||
      typeof password !== 'string' ||
      password.length < 20 ||
      password.length > 256 ||
      typeof displayName !== 'string' ||
      displayName.trim().length < 1 ||
      displayName.length > 100
    ) {
      throw new HttpError(
        400,
        'Invite, generated account password, and display name are required'
      );
    }
    let data: Registration;
    try {
      data = RegisterAccountSchema.parse({ ...input, sessionId: '' });
    } catch {
      throw new HttpError(400, 'Invalid public registration key material');
    }
    const requestHash = hashText(
      canonicalJSON({ data, password, displayName: displayName.trim() })
    );
    const invite = this.store.findInvite(inviteCode);
    if (!invite) {
      throw new HttpError(403, 'Invalid invite');
    }
    if (invite.response) {
      if (invite.request_hash !== requestHash) {
        throw new HttpError(409, 'Invite already used by another registration');
      }
      return JSON.parse(invite.response);
    }
    if (invite.expires < Date.now()) {
      throw new HttpError(403, 'Invite expired');
    }

    const aciKeys = decodeKeys(
      data.aciIdentityKey,
      data.aciSignedPreKey,
      data.aciPqLastResortPreKey
    );
    if (!data.pniSignedPreKey || !data.pniPqLastResortPreKey) {
      throw new HttpError(
        400,
        'PNI public keys are required for this compatibility build'
      );
    }
    const pniKeys = decodeKeys(
      data.pniIdentityKey,
      data.pniSignedPreKey,
      data.pniPqLastResortPreKey
    );
    const pniRegistrationId =
      data.accountAttributes.pniRegistrationId ??
      Number(data.accountAttributes.phoneNumberIdentityRegistrationId);
    if (
      !Number.isInteger(pniRegistrationId) ||
      pniRegistrationId < 1 ||
      pniRegistrationId > 16383
    ) {
      throw new HttpError(400, 'Invalid PNI registration ID');
    }
    const accessKey = Buffer.from(data.accountAttributes.unidentifiedAccessKey);
    if (accessKey.length !== 16) {
      throw new HttpError(400, 'Invalid unidentified access key');
    }

    // This is a private compatibility identifier, never a real phone number, and
    // is never registered with Signal/SMS services or used for phone discovery.
    let number: string;
    do {
      number = `+999${randomInt(100000000, 999999999)}`;
    } while (allDevices(this).some(device => device.number === number));
    const device = await this.registerDevice({
      number,
      password,
      registrationId: data.accountAttributes.registrationId,
      pniRegistrationId: pniRegistrationId as RegistrationId,
      authCredentialSalt: randomBytes(16),
    });
    await device.setKeys(ServiceIdKind.ACI, aciKeys);
    await device.setKeys(ServiceIdKind.PNI, pniKeys);
    device.accessKey = accessKey;
    // Profile display names subsequently arrive through Signal's encrypted profile API.
    const response = {
      uuid: device.aci,
      number,
      pni: device.pni!.replace(/^PNI:/, ''),
      deviceId: 1,
      storageCapable: false,
      reregistration: false,
      entitlements: { badges: [] },
    };
    this.store.transaction(() => {
      this.store.addCredential(device.debugId, password);
      this.store.db
        .prepare('INSERT INTO directory VALUES(?,?)')
        .run(device.aci, displayName.trim());
      this.persist();
      this.store.consumeInvite(inviteCode, requestHash, response);
    });
    // Account authentication is always checked against the scrypt hash above.
    // Remove the test implementation's redundant plaintext credential immediately.
    const authEntries = (
      this as unknown as { devicesByAuth: Map<string, unknown> }
    ).devicesByAuth;
    authEntries.delete(device.debugId);
    return response;
  }

  public override async handleMessage(
    source: Device | undefined,
    serviceIdKind: ServiceIdKind,
    envelopeType: EnvelopeType,
    target: Device,
    encrypted: Buffer<ArrayBuffer>,
    timestamp: bigint
  ): Promise<void> {
    const types = {
      [EnvelopeType.CipherText]: Proto.Envelope.Type.DOUBLE_RATCHET,
      [EnvelopeType.PreKey]: Proto.Envelope.Type.PREKEY_MESSAGE,
      [EnvelopeType.SealedSender]: Proto.Envelope.Type.UNIDENTIFIED_SENDER,
      [EnvelopeType.Plaintext]: Proto.Envelope.Type.PLAINTEXT_CONTENT,
    };
    const type = types[envelopeType as keyof typeof types];
    if (
      type === undefined ||
      (!source && envelopeType !== EnvelopeType.SealedSender)
    ) {
      throw new Error('Invalid message envelope');
    }
    const destination = target.getServiceIdBinaryByKind(serviceIdKind);
    assert(destination, 'Missing destination service identifier');
    const guid = randomUUID();
    const envelope = Proto.Envelope.encode({
      type,
      sourceServiceIdBinary: source?.aciBinary ?? null,
      sourceDeviceId: source?.deviceId ?? null,
      destinationServiceIdBinary: destination,
      serverTimestamp: BigInt(Date.now()),
      clientTimestamp: timestamp,
      content: encrypted,
      urgent: null,
      serverGuid: guid,
      serverGuidBinary: Buffer.from(guid.replaceAll('-', ''), 'hex'),
      ephemeral: null,
      story: null,
      reportSpamToken: null,
      updatedPniBinary: null,
      sourceServiceId: null,
      destinationServiceId: null,
      updatedPni: null,
    });
    await this.send(target, Buffer.from(envelope));
  }

  public override async send(
    target: Device,
    message: Buffer<ArrayBuffer>
  ): Promise<void> {
    // Commit ciphertext before telling its sender that the server accepted it.
    this.store.enqueue(target.debugId, message);
    void this.drain(target.debugId);
  }

  public override async getAttachmentUploadForm(
    folder: string,
    key: string
  ): Promise<AttachmentUploadForm> {
    if (folder !== 'attachments' || !/^[a-f0-9-]{36}$/.test(key)) {
      throw new HttpError(403, 'Unsupported demo upload');
    }
    const token = randomBytes(32).toString('base64url');
    const uploadPath = `/cdn3/${folder}/${key}`;
    this.store.db
      .prepare('INSERT OR REPLACE INTO uploads VALUES(?,?,?)')
      .run(uploadPath, hashText(token), Date.now() + 3600000);
    return {
      cdn: 3,
      key,
      headers: { 'X-Sig-Demo-Upload': token },
      signedUploadLocation: `https://localhost:${this.privateConfig.clientPort ?? this.address().port}${uploadPath}`,
    };
  }

  public override async addWebSocket(
    device: Device,
    socket: DeliverySocket
  ): Promise<void> {
    const previous = this.connected.get(device.debugId);
    if (previous && previous !== socket) {
      previous.close(4409);
    }
    this.connected.set(device.debugId, socket);
    void this.drain(device.debugId);
  }

  public override removeWebSocket(
    device: Device,
    socket: DeliverySocket
  ): void {
    if (this.connected.get(device.debugId) === socket) {
      this.connected.delete(device.debugId);
    }
  }

  private async drain(target: string): Promise<void> {
    if (this.draining.has(target)) {
      return;
    }
    this.draining.add(target);
    const socket = this.connected.get(target);
    if (!socket) {
      this.draining.delete(target);
      return;
    }
    try {
      while (this.connected.get(target) === socket) {
        const pending = this.store.firstPending(target);
        if (!pending) {
          // The queue marker is a notification. Never hold the per-device drain
          // lock waiting for it: libsignal may acknowledge it independently of
          // subsequent inbox messages.
          void socket.sendMessage('empty').catch(() => undefined);
          break;
        }
        await socket.sendMessage(pending.envelope);
        this.store.acknowledge(pending.id);
      }
    } catch {
      // Retain every unacknowledged envelope; reconnect retries it with the same GUID.
      if (this.connected.get(target) === socket) {
        this.connected.delete(target);
        socket.close(1011);
      }
    } finally {
      this.draining.delete(target);
      if (this.connected.has(target) && this.connected.get(target) !== socket) {
        void this.drain(target);
      }
    }
  }

  public override async listen(
    port: number,
    host = '127.0.0.1'
  ): Promise<void> {
    if (
      !['127.0.0.1', '::1', 'localhost'].includes(host) &&
      !this.privateConfig.allowPublicListen
    ) {
      throw new Error(
        'Public binding requires the explicit --public deployment flag'
      );
    }
    const config = this.privateConfig;
    const httpHandler = createHTTPHandler(this, {
      cdn3Path: config.cdn3Path,
      updates2Path: config.updates2Path,
    });
    const grpcHandler = createGRPCHandler(this);
    const server = http2.createSecureServer(
      {
        ...config.https,
        allowHTTP1: true,
        settings: { enableConnectProtocol: true },
      },
      (req, res) => {
        const originalEnd = res.end.bind(res);
        // HTTP/group/prekey mutations must be durable before their response completes.
        res.end = ((...args: Parameters<typeof res.end>) => {
          this.persist();
          return originalEnd(...args);
        }) as typeof res.end;
        if (req.url?.startsWith('/v1/sig-demo/') || req.url === '/health') {
          void this.handlePrivateHTTP(req, res).catch(error => {
            if (!res.headersSent) {
              res.writeHead(error instanceof HttpError ? error.status : 500, {
                'content-type': 'application/json',
              });
            }
            res.end(
              JSON.stringify({
                error:
                  error instanceof HttpError
                    ? error.message
                    : 'Private server request failed',
              })
            );
          });
        } else {
          void this.authorizeTransport(req)
            .then(async () => {
              if (
                req.headers['content-type'] === 'application/grpc' &&
                (await handlePrivateGRPC(this, req, res))
              ) {
                return;
              }
              const handler =
                req.headers['content-type'] === 'application/grpc'
                  ? grpcHandler
                  : httpHandler;
              return run(
                req as unknown as IncomingMessage,
                res as unknown as ServerResponse,
                handler
              );
            })
            .catch(error => {
              if (res.headersSent) {
                res.end();
                return;
              }
              if (req.headers['content-type'] === 'application/grpc') {
                res.writeHead(200, { 'content-type': 'application/grpc' });
                res.addTrailers({
                  'grpc-status': '16',
                  'grpc-message': 'Private demo authorization failed',
                });
                res.end();
              } else {
                res.writeHead(error instanceof HttpError ? error.status : 403, {
                  'content-type': 'application/json',
                });
                res.end(
                  JSON.stringify({ error: 'Private demo authorization failed' })
                );
              }
            });
        }
      }
    );
    server.on(
      'connect',
      (req: Http2ServerRequest, res: Http2ServerResponse) => {
        if (req.method !== 'CONNECT' || req.url !== '/v1/websocket/') {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(200);
        const websocket = new WebSocket(
          null as unknown as string,
          undefined,
          {}
        );
        (
          websocket as unknown as {
            setSocket(stream: unknown, head: Buffer, options: object): void;
          }
        ).setSocket(req.stream, Buffer.alloc(0), { maxPayload: 1024 * 1024 });
        const conn = new PrivateConnection(req, websocket, this);
        conn.start(websocket).catch(() => websocket.close(1011));
      }
    );
    this.https = server;
    server.on('session', session => {
      this.httpSessions.add(session);
      session.once('close', () => this.httpSessions.delete(session));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  }

  private async authorizeTransport(req: Http2ServerRequest): Promise<void> {
    let decoded: string;
    try {
      decoded = req.url ?? '';
      for (let i = 0; i < 3; i += 1) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      }
    } catch {
      throw new HttpError(400, 'Invalid request path');
    }
    if (
      !decoded.startsWith('/') ||
      decoded.includes('..') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      throw new HttpError(403, 'Invalid request path');
    }
    const pathname = decoded.split('?')[0]!;
    if (
      pathname.startsWith('/updates2/') ||
      pathname.startsWith('/callingService/') ||
      pathname.includes('backup') ||
      pathname.includes('/archives/')
    ) {
      throw new HttpError(404, 'Feature unavailable');
    }
    if (pathname.startsWith('/cdn3/')) {
      if (!/^\/cdn3\/attachments\/[a-f0-9-]{36}$/.test(pathname)) {
        throw new HttpError(403, 'Invalid attachment path');
      }
      if (req.method !== 'GET') {
        const token = req.headers['x-sig-demo-upload'];
        const upload = this.store.db
          .prepare('SELECT token_hash,expires FROM uploads WHERE path=?')
          .get(pathname);
        if (
          typeof token !== 'string' ||
          !upload ||
          Number(upload.expires) < Date.now() ||
          hashText(token) !== upload.token_hash
        ) {
          throw new HttpError(403, 'Invalid upload capability');
        }
        const length = Number(req.headers['upload-length'] ?? 0);
        if (!Number.isFinite(length) || length > 50 * 1024 * 1024) {
          throw new HttpError(413, 'Attachment exceeds demo size limit');
        }
      }
    }
    if (pathname.includes('MessagesAnonymous/SendMultiRecipientStory')) {
      throw new HttpError(403, 'Stories unavailable');
    }
    if (
      pathname.includes('Attachments/GetUploadForm') &&
      !(await this.authHeader(req.headers.authorization))
    ) {
      throw new HttpError(401, 'Account authentication required');
    }
    if (pathname.endsWith('MessagesAnonymous/SendMultiRecipientMessage')) {
      const raw = Buffer.from(await buffer(req as unknown as IncomingMessage));
      if (
        raw.length < 5 ||
        raw[0] !== 0 ||
        raw.readUInt32BE(1) !== raw.length - 5
      ) {
        throw new HttpError(400, 'Invalid gRPC framing');
      }
      const request =
        org.signal.chat.messages.SendMultiRecipientMessageRequest.decode(
          raw.subarray(5)
        );
      if (!request.message || !request.groupSendToken?.length) {
        throw new HttpError(401, 'Group send authorization required');
      }
      const sealed = new SealedSenderMultiRecipientMessage(
        Buffer.from(request.message.payload)
      );
      this.verifyGroupSendToken(
        Buffer.from(request.groupSendToken),
        Object.keys(sealed.recipientsByServiceIdString())
      );
    }
  }

  private async authHeader(
    header: string | string[] | undefined
  ): Promise<Device | undefined> {
    if (typeof header !== 'string' || !header.startsWith('Basic ')) {
      return undefined;
    }
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const colon = decoded.indexOf(':');
    return colon < 0
      ? undefined
      : this.auth(decoded.slice(0, colon), decoded.slice(colon + 1));
  }

  private async handlePrivateHTTP(
    req: Http2ServerRequest,
    res: Http2ServerResponse
  ): Promise<void> {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    if (req.url === '/health' && req.method === 'GET') {
      res.end(
        JSON.stringify({
          ok: true,
          app: 'sig-demo',
          registration: 'invite-only',
        })
      );
      return;
    }
    if (req.url === '/v1/sig-demo/accounts' && req.method === 'POST') {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 128 * 1024) {
          throw new HttpError(413, 'Registration request too large');
        }
        chunks.push(bytes);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new HttpError(400, 'Invalid JSON');
      }
      res.end(JSON.stringify(await this.registerInvite(body)));
      return;
    }
    if (req.url === '/v1/sig-demo/directory' && req.method === 'GET') {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Basic ')) {
        throw new HttpError(401, 'Authentication required');
      }
      const credentials = Buffer.from(header.slice(6), 'base64').toString();
      const colon = credentials.indexOf(':');
      if (
        colon < 0 ||
        !(await this.auth(
          credentials.slice(0, colon),
          credentials.slice(colon + 1)
        ))
      ) {
        throw new HttpError(401, 'Authentication failed');
      }
      const accounts = this.store.db
        .prepare(
          'SELECT aci AS uuid,display_name AS displayName FROM directory ORDER BY display_name'
        )
        .all();
      res.end(JSON.stringify({ accounts }));
      return;
    }
    throw new HttpError(404, 'Unknown private endpoint');
  }

  public async shutdown(): Promise<void> {
    for (const socket of this.connected.values()) {
      socket.close(1001);
    }
    this.connected.clear();
    for (const session of this.httpSessions) {
      session.destroy();
    }
    this.httpSessions.clear();
    this.persist();
    if (this.https) {
      await this.close();
    }
    this.store.close();
  }
}

function decodeKeys(
  identityBase64: string,
  signed: PublicSignedKey,
  pq: PublicSignedKey
): DeviceKeys {
  try {
    const identityKey = PublicKey.deserialize(
      Buffer.from(identityBase64, 'base64')
    );
    const signedBytes = Buffer.from(signed.publicKey, 'base64');
    const pqBytes = Buffer.from(pq.publicKey, 'base64');
    const signature = Buffer.from(signed.signature, 'base64');
    const pqSignature = Buffer.from(pq.signature, 'base64');
    if (
      !identityKey.verify(signedBytes, signature) ||
      !identityKey.verify(pqBytes, pqSignature)
    ) {
      throw new Error('Bad signed prekey signature');
    }
    return {
      identityKey,
      signedPreKey: {
        keyId: signed.keyId,
        publicKey: PublicKey.deserialize(signedBytes),
        signature,
      },
      lastResortKey: {
        keyId: pq.keyId,
        publicKey: KEMPublicKey.deserialize(pqBytes),
        signature: pqSignature,
      },
    };
  } catch {
    throw new HttpError(
      400,
      'Public key decoding or signature verification failed'
    );
  }
}
