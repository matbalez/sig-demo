// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { startSigDemoRelay } from '../ts/util/sigDemoRelay.node.ts';

const ca = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';

test('relay forwards opaque bytes both ways and shuts down open sockets', async () => {
  const target = createServer(socket => socket.pipe(socket));
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetPort = target.address().port;
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const relayPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const relay = await startSigDemoRelay(
    { host: '127.0.0.1', port: targetPort },
    `https://localhost:${relayPort}`,
    ca
  );
  const socket = createConnection({ host: '127.0.0.1', port: relayPort });
  await once(socket, 'connect');
  const payload = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x05, 0x00, 0xff, 0x61]);
  const response = once(socket, 'data');
  socket.write(payload);
  assert.deepEqual((await response)[0], payload);
  const closed = once(socket, 'close');
  await relay.close();
  await closed;
  await new Promise(resolve => target.close(resolve));
});

test('relay refuses public Signal routing and a self-loop', async () => {
  await assert.rejects(
    startSigDemoRelay(
      { host: 'chat.signal.org', port: 443 },
      'https://localhost:8443',
      ca
    )
  );
  await assert.rejects(
    startSigDemoRelay(
      { host: 'localhost', port: 8443 },
      'https://localhost:8443',
      ca
    )
  );
});
