// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const destination = path.resolve(process.argv[2] ?? '.sig-demo/server-source');
if (existsSync(destination)) {
  throw new Error(`Refusing to replace existing deployment source: ${destination}`);
}
const mockSource = path.join(repoRoot, 'packages/mock-server');
for (const required of ['src/index.js', 'protos/compiled.js', 'protos/compiled.d.ts']) {
  if (!existsSync(path.join(mockSource, required))) {
    throw new Error('Build @signalapp/mock-server before preparing its deployment source.');
  }
}
mkdirSync(destination, { recursive: true });
const filter = filename => !filename.split(path.sep).includes('node_modules') && !filename.endsWith('.tsbuildinfo');
cpSync(mockSource, path.join(destination, 'packages/mock-server'), { recursive: true, filter });
cpSync(path.join(repoRoot, 'sig-demo/server'), path.join(destination, 'sig-demo/server'), { recursive: true, filter });
writeFileSync(path.join(destination, 'package.json'), `${JSON.stringify({ name: 'sig-demo-backend-deployment', private: true }, null, 2)}\n`);
writeFileSync(path.join(destination, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/mock-server'\n  - 'sig-demo/server'\n");
process.stdout.write(`Prepared minimal backend workspace: ${destination}\nInstall there with Node 24.21.0 and pnpm install --prod --ignore-scripts.\n`);
