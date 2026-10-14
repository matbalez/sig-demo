// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Aci, Pni } from '@signalapp/libsignal-client';
import { buffer } from 'micro';
import {
  $services,
  org,
  signalservice as Proto,
} from '@signalapp/mock-server/protos/compiled';
import type { Device } from '@signalapp/mock-server/src/data/device';
import type {
  DeviceId,
  RegistrationId,
  ServiceIdString,
} from '@signalapp/mock-server/src/types';
import type { PrivateServer } from './private-server';

const AUTH_SEND = 'org.signal.chat.messages.Messages/SendMessage';
const SEALED_SEND =
  'org.signal.chat.messages.MessagesAnonymous/SendSingleRecipientMessage';

/** The upstream mock omits these typed send routes used by current Desktop. */
export async function handlePrivateGRPC(
  server: PrivateServer,
  req: Http2ServerRequest,
  res: Http2ServerResponse
): Promise<boolean> {
  const method = req.url?.slice(1);
  if (method !== AUTH_SEND && method !== SEALED_SEND) {
    return false;
  }
  const definition = $services[method];
  const raw = Buffer.from(await buffer(req as unknown as IncomingMessage));
  if (
    raw.length < 5 ||
    raw[0] !== 0 ||
    raw.readUInt32BE(1) !== raw.length - 5
  ) {
    throw new Error('Invalid private gRPC framing');
  }
  const request = definition.Request.decode(raw.subarray(5));
  if (!request.destination || !request.messages) {
    throw new Error('Missing send destination or message bundle');
  }
  const destination =
    request.destination.identityType ===
    org.signal.chat.common.IdentityType.IDENTITY_TYPE_PNI
      ? Pni.fromUuidBytes(request.destination.uuid).getServiceIdString()
      : Aci.fromUuidBytes(request.destination.uuid).getServiceIdString();
  let source: Device | undefined;
  if (method === AUTH_SEND) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Basic ')) {
      const credentials = Buffer.from(header.slice(6), 'base64').toString();
      const colon = credentials.indexOf(':');
      if (colon >= 0) {
        source = await server.auth(
          credentials.slice(0, colon),
          credentials.slice(colon + 1)
        );
      }
    }
    if (!source) {
      throw new Error('Account authentication required');
    }
  } else {
    const sealed =
      request as org.signal.chat.messages.SendSealedSenderMessageRequest;
    const target = await server.getDeviceByServiceId(
      destination as ServiceIdString
    );
    if (!target) {
      reply(res, definition, { response: { destinationNotFound: {} } });
      return true;
    }
    let authorized = false;
    if (
      sealed.authorization &&
      'unidentifiedAccessKey' in sealed.authorization &&
      target.accessKey
    ) {
      const given = Buffer.from(
        sealed.authorization.unidentifiedAccessKey ?? []
      );
      authorized =
        given.length === target.accessKey.length &&
        timingSafeEqual(given, target.accessKey);
    } else if (
      sealed.authorization &&
      'groupSendToken' in sealed.authorization
    ) {
      try {
        server.verifyGroupSendToken(
          Buffer.from(sealed.authorization.groupSendToken ?? []),
          [destination]
        );
        authorized = true;
      } catch {
        /* Return the normal protocol rejection below. */
      }
    }
    if (!authorized) {
      reply(res, definition, {
        response: { failedUnidentifiedAuthorization: {} },
      });
      return true;
    }
  }

  const messages = [...request.messages.messages].map(([deviceId, message]) => {
    if (!message) {
      throw new Error('Missing per-device message');
    }
    const types = org.signal.chat.messages.SendMessageType;
    const mapping: Record<number, Proto.Envelope.Type> = {
      [types.DOUBLE_RATCHET]: Proto.Envelope.Type.DOUBLE_RATCHET,
      [types.PREKEY_MESSAGE]: Proto.Envelope.Type.PREKEY_MESSAGE,
      [types.PLAINTEXT_CONTENT]: Proto.Envelope.Type.PLAINTEXT_CONTENT,
      [types.UNIDENTIFIED_SENDER]: Proto.Envelope.Type.UNIDENTIFIED_SENDER,
    };
    const type = mapping[message.type];
    if (type === undefined) {
      throw new Error('Unsupported per-device message type');
    }
    return {
      type,
      destinationDeviceId: deviceId as DeviceId,
      destinationRegistrationId: message.registrationId as RegistrationId,
      content: Buffer.from(message.payload).toString('base64'),
    };
  });
  const prepared = await server.prepareMultiDeviceMessage(
    source,
    destination as ServiceIdString,
    messages,
    request.messages.timestamp
  );
  if (prepared.status === 'ok') {
    await server.handlePreparedMultiDeviceMessage(
      source,
      prepared.targetServiceId,
      prepared.result
    );
    reply(res, definition, { response: { success: {} } });
  } else if (prepared.status === 'unknown') {
    reply(res, definition, { response: { destinationNotFound: {} } });
  } else {
    reply(res, definition, {
      response: {
        mismatchedDevices: {
          serviceIdentifier: request.destination,
          missingDevices:
            prepared.status === 'incomplete' ? prepared.missingDevices : [],
          extraDevices:
            prepared.status === 'incomplete' ? prepared.extraDevices : [],
          staleDevices:
            prepared.status === 'stale' ? prepared.staleDevices : [],
        },
      },
    });
  }
  return true;
}

function reply(
  res: Http2ServerResponse,
  definition: (typeof $services)[typeof AUTH_SEND | typeof SEALED_SEND],
  response: unknown
): void {
  const data = definition.Response.encode(response as never);
  const header = Buffer.alloc(5);
  header.writeUInt32BE(data.length, 1);
  res.writeHead(200, { 'content-type': 'application/grpc' });
  res.addTrailers({ 'grpc-status': '0' });
  res.end(Buffer.concat([header, data]));
}
