// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, createConnection } from 'node:net';
import type { Server, Socket } from 'node:net';

import {
  assertSigDemoRelayConfig,
  getSigDemoLocalChatPort,
} from './sigDemoIsolation.std.ts';
import type { SigDemoRelayConfig } from './sigDemoIsolation.std.ts';

/** Forward opaque TLS records to our private server; never terminate client TLS. */
export async function startSigDemoRelay(
  relay: SigDemoRelayConfig,
  serverUrl: string,
  certificateAuthority: string
): Promise<{ close: () => Promise<void> }> {
  assertSigDemoRelayConfig(relay);
  const localPort = getSigDemoLocalChatPort(serverUrl, certificateAuthority);
  if (
    (relay.host === 'localhost' || relay.host === '127.0.0.1') &&
    relay.port === localPort
  ) {
    throw new Error('sig demo relay cannot forward to its own listening port.');
  }
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const server: Server = createServer(incoming => {
    track(incoming);
    const outgoing = createConnection({ host: relay.host, port: relay.port });
    track(outgoing);
    const abort = () => {
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on('error', abort);
    outgoing.on('error', abort);
    outgoing.setTimeout(15_000, abort);
    outgoing.once('connect', () => outgoing.setTimeout(0));
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Bind only IPv4 loopback. libsignal's local-test transport uses localhost.
    server.listen(localPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    },
  };
}
