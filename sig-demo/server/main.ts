// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import { PrivateKey } from '@signalapp/libsignal-client';
import {
  GenericServerSecretParams,
  ServerSecretParams,
} from '@signalapp/libsignal-client/zkgroup';
import type { Config } from '@signalapp/mock-server/src/api/server';
import { PrivateServer, type PrivateServerConfig } from './private-server';
import { DemoStore } from './store';

type SecretConfig = {
  trustRoot: NonNullable<Config['trustRoot']>;
  zkParams: NonNullable<Config['zkParams']>;
  clientPort?: number;
};

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

export function loadConfig(dataDir: string): PrivateServerConfig {
  const secrets = JSON.parse(
    readFileSync(path.join(dataDir, 'server-secrets.json'), 'utf8')
  ) as SecretConfig;
  return {
    ...secrets,
    https: {
      cert: readFileSync(path.join(dataDir, 'server-cert.pem')),
      key: readFileSync(path.join(dataDir, 'server-key.pem')),
    },
    cdn3Path: path.join(dataDir, 'cdn3'),
    updates2Path: undefined,
  };
}

export function initialize(
  dataDir: string,
  port: number,
  clientPort = port
): void {
  const secretPath = path.join(dataDir, 'server-secrets.json');
  if (existsSync(secretPath)) {
    throw new Error(
      'Already initialized; refusing to replace server identities or certificates'
    );
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  mkdirSync(path.join(dataDir, 'cdn3'), { recursive: true, mode: 0o700 });
  const trust = PrivateKey.generate();
  const groups = ServerSecretParams.generate();
  const generic = GenericServerSecretParams.generate();
  const backup = GenericServerSecretParams.generate();
  const base64 = (value: Uint8Array) => Buffer.from(value).toString('base64');
  const secrets: SecretConfig = {
    clientPort,
    trustRoot: {
      privateKey: base64(trust.serialize()),
      publicKey: base64(trust.getPublicKey().serialize()),
    },
    zkParams: {
      secretParams: base64(groups.serialize()),
      publicParams: base64(groups.getPublicParams().serialize()),
      genericSecretParams: base64(generic.serialize()),
      genericPublicParams: base64(generic.getPublicParams().serialize()),
      backupSecretParams: base64(backup.serialize()),
      backupPublicParams: base64(backup.getPublicParams().serialize()),
    },
  };
  const caKey = path.join(dataDir, 'ca-key.pem');
  const caCert = path.join(dataDir, 'ca-cert.pem');
  const serverKey = path.join(dataDir, 'server-key.pem');
  const serverCSR = path.join(dataDir, 'server.csr');
  const serverCert = path.join(dataDir, 'server-cert.pem');
  const ext = path.join(dataDir, 'server-ext.cnf');
  writeFileSync(
    ext,
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n',
    { mode: 0o600 }
  );
  const openssl = (args: string[]) =>
    execFileSync('openssl', args, { stdio: 'ignore' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-sha256',
    '-days',
    '3650',
    '-keyout',
    caKey,
    '-out',
    caCert,
    '-subj',
    '/CN=Sig Demo Private CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-sha256',
    '-keyout',
    serverKey,
    '-out',
    serverCSR,
    '-subj',
    '/CN=localhost',
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    serverCSR,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    serverCert,
    '-days',
    '825',
    '-sha256',
    '-extfile',
    ext,
  ]);
  for (const file of [caKey, serverKey]) {
    chmodSync(file, 0o600);
  }
  writeFileSync(secretPath, `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600,
  });

  const url = `https://localhost:${clientPort}`;
  const client = {
    sigDemoEnabled: true,
    sigDemoNetworkMode: 'localhost',
    updatesEnabled: false,
    storageProfile: 'demo',
    serverUrl: url,
    storageUrl: `${url}/storageService`,
    resourcesUrl: `${url}/updates2`,
    sfuUrl: `${url}/callingService`,
    contentProxyUrl: `${url}/disabled`,
    updatesUrl: `${url}/disabled`,
    challengeUrl: `${url}/disabled`,
    registrationChallengeUrl: `${url}/disabled`,
    cdn: { '0': url, '2': url, '3': `${url}/cdn3` },
    certificateAuthority: readFileSync(caCert, 'utf8'),
    serverTrustRoots: [secrets.trustRoot.publicKey],
    serverPublicParams: secrets.zkParams.publicParams,
    genericServerPublicParams: secrets.zkParams.genericPublicParams,
    backupServerPublicParams: secrets.zkParams.backupPublicParams,
    buildExpiration: Date.now() + 90 * 86400000,
  };
  writeFileSync(
    path.join(dataDir, 'client-config.json'),
    `${JSON.stringify(client, null, 2)}\n`,
    { mode: 0o644 }
  );
  const store = new DemoStore(path.join(dataDir, 'demo.sqlite'));
  store.close();
  process.stdout.write(
    `Initialized private backend in ${dataDir}\nPublic client config: ${path.join(dataDir, 'client-config.json')}\n`
  );
}

async function main(): Promise<void> {
  const action = process.argv[2];
  const dataDir = path.resolve(option('data-dir', 'sig-demo/server-data'));
  const port = Number(option('port', '8443'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid port');
  }
  if (action === 'init') {
    initialize(dataDir, port, Number(option('client-port', String(port))));
    return;
  }
  if (action === 'invite') {
    if (!existsSync(path.join(dataDir, 'server-secrets.json'))) {
      throw new Error('Initialize server before creating invites');
    }
    const store = new DemoStore(path.join(dataDir, 'demo.sqlite'));
    process.stdout.write(
      `${store.createInvite(Number(option('hours', '168')))}\n`
    );
    store.close();
    return;
  }
  if (action === 'serve') {
    const isPublic = process.argv.includes('--public');
    const server = new PrivateServer(
      { ...loadConfig(dataDir), allowPublicListen: isPublic },
      path.join(dataDir, 'demo.sqlite')
    );
    await server.restore();
    await server.listen(
      port,
      option('host', isPublic ? '0.0.0.0' : '127.0.0.1')
    );
    process.stdout.write(
      `Private Signal-compatible demo backend listening at https://localhost:${port}\n`
    );
    let closing = false;
    const shutdown = () => {
      if (closing) {
        return;
      }
      closing = true;
      void server.shutdown().then(
        () => process.exit(0),
        () => process.exit(1)
      );
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
  throw new Error(
    'Usage: node --import tsx sig-demo/server/main.ts init|invite|serve [--data-dir PATH] [--port 8443] [--host 127.0.0.1]'
  );
}

if (require.main === module) {
  void main().catch(error => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Server failed'}\n`
    );
    process.exitCode = 1;
  });
}
