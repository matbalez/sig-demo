// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Net } from '@signalapp/libsignal-client';

import { getUserAgent } from '../util/getUserAgent.node.ts';
import { getSigDemoLocalChatPort } from '../util/sigDemoIsolation.std.ts';
import { pemToDer } from '../util/pemToDer.std.ts';
import { drop } from '../util/drop.std.ts';
import { toLogFormat } from '../types/errors.std.ts';
import { createLogger } from '../logging/log.std.ts';

const log = createLogger('preconnect');

// Libsignal has internally configured values for domain names
// (and other connectivity params) of the services.
function resolveLibsignalNet(
  url: string,
  version: string,
  certificateAuthority?: string
): Net.Net {
  const port = getSigDemoLocalChatPort(url, certificateAuthority);
  const userAgent = getUserAgent(version);
  log.info(`libsignal net url: ${url}`);
  const DISCARD_PORT = 9; // Reserved by RFC 863.
  log.info('libsignal net environment resolved to isolated local test server');
  return new Net.Net({
    localTestServer: true,
    userAgent,
    TESTING_localServer_chatPort: port,
    TESTING_localServer_cdsiPort: DISCARD_PORT,
    TESTING_localServer_svr2Port: DISCARD_PORT,
    TESTING_localServer_svrBPort: DISCARD_PORT,
    TESTING_localServer_rootCertificateDer: pemToDer(certificateAuthority ?? ''),
    TESTING_localServer_httpVersion: 2,
  });
}

// `libsignalNet` is an instance of a class from libsignal that is responsible
// for providing network layer API and related functionality.
// It's important to have a single instance of this class as it holds
// resources that are shared across all other use cases.
let libsignalNet: Net.Net;

export function getLibsignalNet(): Net.Net {
  return libsignalNet;
}

// Not defined in tests
if (window.SignalContext.config?.serverUrl) {
  const { config } = window.SignalContext;

  libsignalNet = resolveLibsignalNet(
    config.serverUrl,
    config.version,
    config.certificateAuthority
  );

  libsignalNet.setIpv6Enabled(!config.disableIPv6);
  if (config.proxyUrl) {
    throw new Error('sig demo local test transport must not use a proxy.');
  }

  drop(
    (async () => {
      try {
        log.info('WebAPI: preconnect start');
        await libsignalNet.preconnectChat();
        log.info('WebAPI: preconnect done');
      } catch (error) {
        log.error(`WebAPI: Failed to preconnect: ${toLogFormat(error)}`);
      }
    })()
  );
}
