// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

/** Only the audited localhost mock transport is enabled in this initial fork. */
export function getSigDemoLocalChatPort(
  serverUrl: string,
  certificateAuthority: string | undefined
): number {
  const url = new URL(serverUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'localhost' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.port === '' ||
    Number(url.port) === 0
  ) {
    throw new Error(
      'sig demo can only use an explicit https://localhost:<port> test server; Signal production and staging are disabled.'
    );
  }
  if (
    !certificateAuthority?.startsWith('-----BEGIN CERTIFICATE-----\n') ||
    !certificateAuthority.trimEnd().endsWith('-----END CERTIFICATE-----')
  ) {
    throw new Error('sig demo requires a configured local test certificate.');
  }
  return Number(url.port);
}

export type SigDemoRelayConfig = Readonly<{ host: string; port: number }>;

export function assertSigDemoRelayConfig(
  value: unknown
): asserts value is SigDemoRelayConfig {
  if (value == null || typeof value !== 'object') {
    throw new Error(
      'sig demo relay requires an approved private host and port.'
    );
  }
  const relay = value as Record<string, unknown>;
  if (
    typeof relay.host !== 'string' ||
    !['51.159.213.86', 'localhost', '127.0.0.1'].includes(relay.host) ||
    typeof relay.port !== 'number' ||
    !Number.isInteger(relay.port) ||
    relay.port < 1 ||
    relay.port > 65535
  ) {
    throw new Error(
      'sig demo relay target is not an approved private endpoint.'
    );
  }
}

function assertLocalEndpoint(
  value: unknown,
  name: string,
  requiredOrigin?: string
): void {
  if (typeof value !== 'string') {
    throw new Error(`sig demo requires a local ${name}.`);
  }
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'localhost' ||
    url.port === '' ||
    Number(url.port) === 0 ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(`sig demo ${name} must use https://localhost:<port>.`);
  }
  if (requiredOrigin !== undefined && url.origin !== requiredOrigin) {
    throw new Error(
      `sig demo ${name} must use the configured localhost relay.`
    );
  }
}

/** Reject merged config overrides before creating a window or starting networking. */
export function assertSigDemoNetworkConfig(value: unknown): void {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'sig demo requires an explicit private network configuration.'
    );
  }
  const config = value as Record<string, unknown>;
  if (
    config.sigDemoNetworkMode !== 'localhost' ||
    config.sigDemoEnabled !== true
  ) {
    throw new Error(
      'sig demo networking is blocked until a private backend is configured. Use the local demo launcher to preview the app.'
    );
  }
  if (config.updatesEnabled !== false) {
    throw new Error('sig demo disables the upstream Signal updater.');
  }
  if (typeof config.serverUrl !== 'string') {
    throw new Error('sig demo requires a local serverUrl.');
  }
  getSigDemoLocalChatPort(
    config.serverUrl,
    typeof config.certificateAuthority === 'string'
      ? config.certificateAuthority
      : undefined
  );
  let requiredOrigin: string | undefined;
  if (config.sigDemoRelay !== undefined) {
    assertSigDemoRelayConfig(config.sigDemoRelay);
    requiredOrigin = new URL(config.serverUrl).origin;
  }
  for (const name of [
    'storageUrl',
    'contentProxyUrl',
    'updatesUrl',
    'resourcesUrl',
    'sfuUrl',
    'challengeUrl',
    'registrationChallengeUrl',
  ]) {
    assertLocalEndpoint(config[name], name, requiredOrigin);
  }
  const cdn = config.cdn as Record<string, unknown> | undefined;
  for (const index of ['0', '2', '3']) {
    assertLocalEndpoint(cdn?.[index], `cdn.${index}`, requiredOrigin);
  }
}
