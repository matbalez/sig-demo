// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { format, resolveConfig } from 'prettier';

const outputDirectory = process.argv[2]
  ? pathToFileURL(`${resolve(process.argv[2])}/`)
  : new URL('./generated/', import.meta.url);
const schema = JSON.parse(
  await readFile(new URL('schema.json', outputDirectory), 'utf8')
);
const camel = name =>
  name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const errorEnums = new Set(
  schema.enums
    .filter(value => value.name.endsWith('Error'))
    .map(value => value.name)
);
const nameOf = name => (errorEnums.has(name) ? `${name}Data` : name);
const usedObjects = new Set();
function typeOf(type) {
  if (!type) return 'void';
  switch (type.kind) {
    case 'optional':
      return `${typeOf(type.inner)} | null`;
    case 'sequence':
    case 'set':
      return `ReadonlyArray<${typeOf(type.inner)}>`;
    case 'map':
      return `Readonly<Record<${typeOf(type.key)}, ${typeOf(type.value)}>>`;
    case 'record':
    case 'enum':
      return nameOf(type.name);
    case 'object':
      if (
        [
          'Provider',
          'ProviderStream',
          'SigAgentStream',
          'SigAgentSession',
        ].includes(type.name)
      ) {
        usedObjects.add(type.name);
        return type.name;
      }
      return 'unknown';
    case 'callback':
      return 'unknown';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'bytes':
      return 'Uint8Array<ArrayBuffer>';
    case 'uint64':
    case 'int64':
      return 'number | bigint';
    default:
      return 'number';
  }
}
const fieldOf = field =>
  `${camel(field.name)}${field.type.kind === 'optional' || Object.hasOwn(field, 'default') ? '?' : ''}: ${typeOf(field.type)}`;
const definitions = [
  '// Copyright 2026 sig demo contributors',
  '// SPDX-License-Identifier: AGPL-3.0-only',
  '// Generated from the SDK cdylib UniFFI metadata. Run generate-types.node.mjs; do not edit.',
  '',
];
for (const record of schema.records) {
  definitions.push(
    `export type ${record.name} = Readonly<{ ${record.fields.map(fieldOf).join('; ')} }>;`
  );
}
for (const enumeration of schema.enums) {
  const variants = enumeration.variants.map(variant =>
    enumeration.flat
      ? JSON.stringify(variant.name)
      : `Readonly<{ kind: ${JSON.stringify(variant.name)}; ${variant.fields.map(fieldOf).join('; ')} }>`
  );
  definitions.push(
    `export type ${nameOf(enumeration.name)} = ${variants.join(' | ')};`
  );
}
if (usedObjects.size) {
  definitions.splice(
    3,
    0,
    `import type { ${[...usedObjects].join(', ')} } from '../${schema.namespace === 'sig_demo_agent' ? 'agent-bindings' : 'bindings'}.node.ts';`
  );
}
const options = await resolveConfig(
  fileURLToPath(new URL('types.std.ts', outputDirectory))
);
const formatTypes = source =>
  format(source, { ...options, parser: 'typescript' });
await writeFile(
  new URL('types.std.ts', outputDirectory),
  await formatTypes(`${definitions.join('\n')}\n`)
);
await writeFile(
  new URL('schema.std.ts', outputDirectory),
  await formatTypes(
    `// Copyright 2026 sig demo contributors\n// SPDX-License-Identifier: AGPL-3.0-only\n// Generated from the SDK cdylib UniFFI metadata. Do not edit.\nexport const uniffiSchema = ${JSON.stringify(schema, null, 2)} as const;\n`
  )
);
await writeFile(
  new URL('schema.json', outputDirectory),
  await format(`${JSON.stringify(schema, null, 2)}\n`, {
    ...options,
    parser: 'json',
  })
);
