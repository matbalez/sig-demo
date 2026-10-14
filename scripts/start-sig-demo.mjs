// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node scripts/start-sig-demo.mjs [--config FILE] [--profile NAME]

Starts the isolated sig demo desktop using your private server's public config.
Default config: .sig-demo/client.json
Default profile: demo

Initialize and start the private server before launching the desktop.
Different profiles create independent demo identities; never import Signal data.`);
  process.exit(0);
}
let configPath = resolve(root, '.sig-demo/client.json');
let profile = 'demo';
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  const value = args[index + 1];
  if (argument === '--config' && value) {
    configPath = resolve(value);
    index += 1;
  } else if (argument === '--profile' && value) {
    profile = value;
    index += 1;
  } else {
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
}
if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(profile)) {
  throw new Error(
    'Profile must contain 1–48 lowercase letters, digits, _ or -.'
  );
}
if (!existsSync(configPath)) {
  console.error(`Private backend config missing: ${configPath}
Initialize sig demo's server to generate its public client config first.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.storageProfile = profile;
config.sigDemoEnabled = true;
config.sigDemoNetworkMode = 'localhost';
config.updatesEnabled = false;
config.openDevTools = false;
delete config.storagePath;
delete config.proxyUrl;
const require = createRequire(import.meta.url);
const electron = require('electron');
if (!existsSync(resolve(root, 'bundles/main.js'))) {
  throw new Error('Desktop assets are missing. Run pnpm run generate first.');
}
const env = {
  ...process.env,
  NODE_ENV: 'development',
  NODE_CONFIG: JSON.stringify(config),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_APP_INSTANCE;
delete env.NODE_CONFIG_STRICT_MODE;
delete env.IS_BUNDLED;
for (const name of [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
]) {
  delete env[name];
}
console.log(
  `Starting sig demo profile '${profile}' with private config ${configPath}`
);
const child = spawn(electron, [root], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.once('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
