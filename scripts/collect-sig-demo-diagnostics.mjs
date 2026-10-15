// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Read-only incident capture for the app's inference client.
// Never invoke discovery or active connection diagnostics,
// inference, wallet operations, or controls: those can change the evidence.
import { execFileSync } from 'node:child_process';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const LIMIT = 1024 * 1024;
const METRICS = [
  'request_count',
  'successful_requests',
  'retry_count',
  'failover_count',
  'attempt_timeout_count',
  'attempt_unavailable_count',
  'attempt_context_overflow_count',
  'attempt_reject_count',
  'attempt_count',
  'success_count',
  'timeout_count',
  'unavailable_count',
  'context_overflow_count',
  'reject_count',
  'avg_queue_wait_ms',
  'avg_attempt_ms',
];
const CODES = new Set([
  'application-error',
  'rate-limited',
  'output-token-limit',
  'context-length',
  'authentication',
  'timeout',
  'provider-unavailable',
  'payment-required',
  'server-error',
  'endpoint-not-found',
  'request-rejected',
  'local-startup',
  'configuration-error',
  'node-unavailable',
  'model-unavailable',
  'tool-arguments-invalid',
  'tool-arguments-incomplete',
  'stream-format-invalid',
  'stream-interrupted',
  'network-connect',
  'network-error',
  'generic',
]);
const PROVIDERS = new Set(['chatgpt', 'mesh-llm', 'mesh-llm-paid']);
const PHASES = new Set([
  'provider-configuration',
  'runtime-configuration',
  'native-library',
  'inference-discovery',
  'runtime-starting',
  'runtime-started',
  'model-turn',
  'search',
  'answer-first-text',
  'answer',
  'warmup',
]);
const REASONS = new Set([
  'payment-not-authorized',
  'payment-route-denied',
  'paid-start-failed',
  'paid-interrupted',
  'payment-origin-denied',
  'payment-protocol-required',
  'seller-payment-unavailable',
  'payment-intent-invalid',
  'mesh-no-serving-peer',
  'mesh-routes-exhausted',
  'port-in-use',
  'mesh-binary-missing',
  'mesh-startup-stopped',
  'mesh-startup-timeout',
  'wallet-install-failed',
  'provider-changed',
]);
const EVENTS = new Set([
  'Inference request failed',
  'Inference request finished',
  'Inference setup failed',
  'Inference route ready',
  'Inference first text received',
]);
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function numeric(value, keys) {
  return Object.fromEntries(
    keys.flatMap(key =>
      number(value?.[key]) === undefined ? [] : [[key, value[key]]]
    )
  );
}
function node(value) {
  return typeof value === 'string' &&
    /^(?:[a-f0-9]{10}|[a-f0-9]{64})$/i.test(value)
    ? value.slice(0, 10).toLowerCase()
    : undefined;
}
function model(value) {
  return typeof value === 'string' &&
    value.length <= 96 &&
    /^[a-z0-9][a-z0-9._:/+#-]*$/i.test(value) &&
    !value.includes('://') &&
    !/(?:^sk-|^gsk_|^BSA|api.?key|secret|credential|token)/i.test(value)
    ? value
    : undefined;
}
function version(value) {
  return typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:[-+][a-z0-9._-]{1,20})?$/i.test(value)
    ? value
    : undefined;
}
function list(value) {
  return Array.isArray(value) ? value.slice(0, 100) : [];
}

export function safeAgentEvents(text) {
  const result = [];
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line);
      const match = entry.msg?.match(/^\[SigDemoAgent\] ([^{]+) (\{.*\})$/);
      if (!match || !EVENTS.has(match[1])) continue;
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.time))
        continue;
      const data = JSON.parse(match[2]);
      result.push({
        time: entry.time,
        event: match[1],
        provider: PROVIDERS.has(data.provider) ? data.provider : undefined,
        reference: /^[a-f0-9]{8}$/i.test(data.diagnosticId)
          ? data.diagnosticId
          : undefined,
        errorCode: CODES.has(data.errorCode) ? data.errorCode : undefined,
        phase: PHASES.has(data.phase) ? data.phase : undefined,
        reason: REASONS.has(data.reasonCode) ? data.reasonCode : undefined,
        httpStatus:
          Number.isInteger(data.httpStatus) &&
          data.httpStatus >= 100 &&
          data.httpStatus <= 599
            ? data.httpStatus
            : undefined,
        node: node(data.nodeId),
        model: model(data.model),
        result: ['error', 'complete'].includes(data.result)
          ? data.result
          : undefined,
        ...numeric(data, [
          'modelTurns',
          'totalMs',
          'routeWaitMs',
          'runtimeToFirstTextMs',
        ]),
      });
    } catch {
      /* Ignore incomplete log lines and all unrecognized content. */
    }
  }
  return result.slice(-60);
}

export function safeMeshSnapshot(
  health,
  status,
  models,
  nowSeconds,
  diagnostics
) {
  return {
    version: version(status?.version),
    node: node(status?.node_id),
    client:
      typeof status?.is_client === 'boolean' ? status.is_client : undefined,
    serving: typeof status?.is_host === 'boolean' ? status.is_host : undefined,
    live: numeric(health?.mesh, [
      'admitted_peer_count',
      'connected_peer_count',
    ]),
    processes: list(status?.local_instances)
      .filter(p => p.is_self === true)
      .map(p => ({
        ...numeric(p, ['pid', 'api_port', 'started_at_unix']),
        ageSeconds:
          number(p.started_at_unix) > 0 && nowSeconds >= p.started_at_unix
            ? Math.floor(nowSeconds - p.started_at_unix)
            : undefined,
      })),
    peers: list(status?.peers).map(p => ({
      node: node(p.id),
      version: version(p.version),
      path: ['direct', 'relay', 'unknown'].includes(p.latency_source)
        ? p.latency_source
        : undefined,
      ...numeric(p, [
        'rtt_ms',
        'latency_ms',
        'latency_age_ms',
        'first_joined_mesh_ts',
      ]),
    })),
    peerFreshness: list(diagnostics?.peers).map(p => ({
      node: node(p.peer_id),
      ...numeric(p, ['last_seen_secs_ago']),
    })),
    metrics: numeric(status?.routing_metrics, METRICS),
    models: list(models?.mesh_models).map(m => ({
      model: model(m.name),
      metrics: numeric(m.routing_metrics, METRICS),
      targets: list(m.routing_metrics?.targets).map(t => ({
        node: node(t.target),
        ...numeric(t, METRICS),
      })),
    })),
    metadataLoggingEnabled:
      typeof status?.logging?.metadata_available === 'boolean'
        ? status.logging.metadata_available
        : undefined,
  };
}

// Node's HTTP client ignores proxy environment variables and follows no redirects.
export function readLocalJson(path) {
  if (
    !['/health', '/api/status', '/api/models', '/api/diagnostics'].includes(
      path
    )
  )
    throw new Error('Only read-only mesh snapshot routes are allowed.');
  return new Promise(resolveResult => {
    const request = get(
      { hostname: '127.0.0.1', port: 3131, path, agent: false },
      response => {
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > LIMIT)
            request.destroy(new Error('Snapshot response exceeded its limit'));
          else chunks.push(chunk);
        });
        response.on('error', () => resolveResult({ ok: false }));
        response.on('end', () => {
          if (response.statusCode !== 200 || size > LIMIT)
            return resolveResult({ ok: false });
          try {
            resolveResult({
              ok: true,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch {
            resolveResult({ ok: false });
          }
        });
      }
    );
    const deadline = setTimeout(
      () => request.destroy(new Error('Snapshot deadline')),
      4000
    );
    request.on('close', () => clearTimeout(deadline));
    request.on('error', () => resolveResult({ ok: false }));
  });
}

async function recentAgentEvents() {
  let file;
  try {
    file = await open(
      join(
        homedir(),
        'Library/Application Support/sig demo/demo/logs/main.log'
      ),
      'r'
    );
    const { size } = await file.stat();
    const bytes = Buffer.alloc(Math.min(size, LIMIT));
    await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return { available: true, events: safeAgentEvents(bytes.toString('utf8')) };
  } catch {
    return { available: false, events: [] };
  } finally {
    await file?.close();
  }
}

export function safeProcessAges(text) {
  return text
    .split('\n')
    .flatMap(line => {
      const match = line.match(
        /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+.*\/sig demo\.app\/Contents\/(MacOS\/sig demo|Resources\/sig-demo-mesh\/mesh-llm)$/
      );
      return match
        ? [
            {
              kind: match[6].startsWith('MacOS/') ? 'app' : 'mesh',
              pid: Number(match[1]),
              ageSeconds:
                Number(match[2] ?? 0) * 86400 +
                Number(match[3] ?? 0) * 3600 +
                Number(match[4]) * 60 +
                Number(match[5]),
            },
          ]
        : [];
    })
    .slice(0, 8);
}

function processAges() {
  try {
    const text = execFileSync('/bin/ps', ['-axo', 'pid=,etime=,comm='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: LIMIT,
    });
    return safeProcessAges(text);
  } catch {
    return [];
  }
}

export async function collect() {
  const capturedAt = new Date();
  const [health, status, models, diagnostics, agent] = await Promise.all([
    readLocalJson('/health'),
    readLocalJson('/api/status'),
    readLocalJson('/api/models'),
    readLocalJson('/api/diagnostics'),
    recentAgentEvents(),
  ]);
  const processes = processAges();
  const mesh = safeMeshSnapshot(
    health.value,
    status.value,
    models.value,
    capturedAt.getTime() / 1000,
    diagnostics.value
  );
  // Upstream sometimes reports started_at_unix=0 (unknown). Prefer the actual
  // elapsed time of the app-owned process, never interpret zero as epoch time.
  for (const entry of mesh.processes) {
    const owned = processes.find(p => p.kind === 'mesh' && p.pid === entry.pid);
    if (owned) entry.ageSeconds = owned.ageSeconds;
  }
  const report = {
    formatVersion: 1,
    capturedAtUtc: capturedAt.toISOString(),
    scope:
      'Read-only inference-client snapshots; no inference, discovery, wallet calls or process changes.',
    limitation:
      'Mesh 0.78.1 discards some paid pre-invoice error causes. This snapshot cannot recover those causes or guarantee a diagnosis.',
    appProcesses: processes.filter(p => p.kind === 'app'),
    meshProcesses: processes.filter(p => p.kind === 'mesh'),
    endpoints: {
      health: health.ok,
      status: status.ok,
      models: models.ok,
      diagnostics: diagnostics.ok,
    },
    mesh,
    agent,
  };
  const directory = join(ROOT, '.sig-demo', 'diagnostics');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `sig-demo-${capturedAt.toISOString().replace(/[:.]/g, '-')}.json`
  );
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return path;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.stdout.write(`Saved diagnostic snapshot: ${await collect()}\n`);
  } catch {
    process.stderr.write('Could not save the diagnostic snapshot.\n');
    process.exitCode = 1;
  }
}
