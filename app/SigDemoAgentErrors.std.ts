// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { SigDemoInferenceProviderType } from '../ts/types/SigDemoAgent.std.ts';

const ERROR_CODES = [
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
] as const;

export type SigDemoAgentErrorCodeType = (typeof ERROR_CODES)[number];
const allowedCodes = new Set<string>(ERROR_CODES);
const reasonCodes = new Set([
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
const phases = new Set([
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
function isErrorCode(value: unknown): value is SigDemoAgentErrorCodeType {
  return typeof value === 'string' && allowedCodes.has(value);
}

/** Messages constructed by the application, safe to display without SDK details. */
export class SigDemoAgentRuntimeError extends Error {
  readonly code: SigDemoAgentErrorCodeType;
  readonly httpStatus: number | undefined;
  readonly reasonCode: string | undefined;

  constructor(
    message: string,
    code?: unknown,
    diagnostics?: Readonly<{ httpStatus?: unknown; reasonCode?: unknown }>
  ) {
    super(message);
    // Untyped callers cannot put provider diagnostics into a logging field.
    this.code = isErrorCode(code) ? code : 'application-error';
    const status = diagnostics?.httpStatus;
    this.httpStatus =
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? status
        : undefined;
    const reason = diagnostics?.reasonCode;
    this.reasonCode =
      typeof reason === 'string' && reasonCodes.has(reason)
        ? reason
        : undefined;
  }
}

/** Return only fixed labels; SDK diagnostics may contain chat text or secrets. */
export function sigDemoAgentErrorCode(
  error: unknown
): SigDemoAgentErrorCodeType {
  if (error instanceof SigDemoAgentRuntimeError) {
    return allowedCodes.has(error.code) ? error.code : 'application-error';
  }
  if (error == null || typeof error !== 'object' || !('kind' in error)) {
    return 'generic';
  }
  switch (error.kind) {
    case 'RateLimited':
      return 'rate-limited';
    case 'OutputTokenLimitExceeded':
      return 'output-token-limit';
    case 'ContextLengthExceeded':
      return 'context-length';
    case 'Authentication':
      return 'authentication';
    case 'Timeout':
      return 'timeout';
    case 'ProviderUnavailable':
      return 'provider-unavailable';
    case 'Generic': {
      // Thrown GooseError uses details; a streamed GooseStreamError uses message.
      let details = '';
      if ('details' in error && typeof error.details === 'string') {
        details = error.details;
      } else if ('message' in error && typeof error.message === 'string') {
        details = error.message;
      }
      if (details.startsWith("-32602: The model's response was truncated")) {
        // GDK also uses this heuristic for missing argument fragments. It does
        // not prove that the provider actually reached its output-token limit.
        return 'tool-arguments-incomplete';
      }
      if (
        details.startsWith(
          '-32602: The model produced malformed tool arguments.'
        ) ||
        details.startsWith('-32602: Tool arguments for ') ||
        details.startsWith(
          '-32602: Could not interpret tool use parameters for id '
        )
      ) {
        return 'tool-arguments-invalid';
      }
      if (
        details.startsWith(
          'Network error: Stream decode error: Failed to parse streaming chunk:'
        )
      ) {
        return 'stream-format-invalid';
      }
      if (
        details.startsWith(
          'Network error: Stream decode error: error decoding response body'
        )
      ) {
        return 'stream-interrupted';
      }
      if (details.startsWith('Network error: Could not connect to ')) {
        return 'network-connect';
      }
      if (details.startsWith('Network error:')) {
        return 'network-error';
      }
      const normalized = details.toLowerCase();
      return normalized.includes('model_not_found') ||
        normalized.includes('does not exist')
        ? 'model-unavailable'
        : 'generic';
    }
    default:
      return 'generic';
  }
}

/** Expose static messages, preserving only trusted application error text. */
export function safeSigDemoAgentError(error: unknown): string {
  if (error instanceof SigDemoAgentRuntimeError) {
    return error.message;
  }
  switch (sigDemoAgentErrorCode(error)) {
    case 'rate-limited':
      return 'Sig is busy. Try again shortly.';
    case 'output-token-limit':
      return "Sig's response exceeded the output limit.";
    case 'context-length':
      return 'The submitted message is too long for this model.';
    case 'authentication':
      return "Sig's API credential was rejected.";
    case 'timeout':
      return "Sig's request timed out. Try again.";
    case 'provider-unavailable':
      return "Sig's model provider is unavailable.";
    case 'payment-required':
      return 'Paid inference could not be authorized or started. Check Wallet and try again.';
    case 'server-error':
      return 'The inference provider returned a server error. Please try again.';
    case 'endpoint-not-found':
      return 'The inference endpoint was not found. Please try another node.';
    case 'request-rejected':
      return 'The inference provider rejected this request.';
    case 'model-unavailable':
      return 'The configured Sig model is unavailable for this API key.';
    case 'tool-arguments-invalid':
    case 'tool-arguments-incomplete':
      return 'The inference provider returned an invalid web search request. Please try again.';
    case 'stream-format-invalid':
      return 'The inference provider returned an unreadable response. Please try again.';
    case 'stream-interrupted':
      return 'The inference connection closed before Sig finished. Please try again.';
    case 'network-connect':
      return 'Sig could not connect to the inference provider. Try again.';
    case 'network-error':
      return "Sig's connection to the inference provider failed. Try again.";
    default:
      return 'Sig could not complete the request. Try again.';
  }
}

export type SigDemoAgentSetupPhaseType =
  | 'provider-configuration'
  | 'runtime-configuration'
  | 'native-library'
  | 'inference-discovery';

/** Identify local setup failures before applying a discovery-only fallback. */
export function sigDemoAgentSetupError(
  error: unknown,
  phase: SigDemoAgentSetupPhaseType,
  provider: SigDemoInferenceProviderType,
  hasSelection: boolean
): SigDemoAgentRuntimeError {
  if (error instanceof SigDemoAgentRuntimeError) return error;
  if (error instanceof Error) {
    switch (error.message) {
      case 'The mesh binary is missing.':
        return new SigDemoAgentRuntimeError(
          'The mesh binary is missing from this build.',
          'local-startup',
          { reasonCode: 'mesh-binary-missing' }
        );
      case 'A mesh port is already in use by another application.':
        return new SigDemoAgentRuntimeError(
          'Another application is using a local mesh port. Close it and restart sig demo.',
          'local-startup',
          { reasonCode: 'port-in-use' }
        );
      case 'The mesh client stopped during startup.':
        return new SigDemoAgentRuntimeError(
          'The local mesh client stopped during startup. Restart sig demo and try again.',
          'local-startup',
          { reasonCode: 'mesh-startup-stopped' }
        );
      case 'The mesh client did not become ready.':
        return new SigDemoAgentRuntimeError(
          'The local mesh client did not become ready. Restart sig demo and try again.',
          'local-startup',
          { reasonCode: 'mesh-startup-timeout' }
        );
      case 'The local wallet could not be installed. Please try again.':
        return new SigDemoAgentRuntimeError(
          'The local wallet plugin could not be installed. Check your connection and try again.',
          'local-startup',
          { reasonCode: 'wallet-install-failed' }
        );
      case 'The private paid mesh is not configured in this build.':
        return new SigDemoAgentRuntimeError(
          'The private paid mesh is not configured in this build.',
          'configuration-error'
        );
      case 'The selected mesh model or node is invalid.':
        return new SigDemoAgentRuntimeError(
          'The selected mesh model or node is invalid. Choose another under General → Inference.',
          'node-unavailable'
        );
      case 'The inference provider changed.':
      case 'The mesh was stopped.':
        return new SigDemoAgentRuntimeError(
          'The inference provider changed. Please try again.',
          'application-error',
          { reasonCode: 'provider-changed' }
        );
      default:
        break;
    }
  }
  if (phase === 'runtime-configuration' || phase === 'native-library') {
    return new SigDemoAgentRuntimeError(
      phase === 'native-library'
        ? 'The native Sig agent is missing or unavailable in this build.'
        : 'Sig is not configured correctly in this build.',
      'configuration-error'
    );
  }
  if (phase === 'provider-configuration') {
    return new SigDemoAgentRuntimeError(
      'The local inference client could not start. Restart sig demo and try again.',
      'local-startup'
    );
  }
  let message = 'Sig is not configured in this build.';
  if (provider !== 'chatgpt' && hasSelection) {
    message =
      'The selected model or node is unavailable. Choose another under General → Inference, or select Automatic.';
  } else if (provider === 'mesh-llm-paid') {
    message =
      'Paid mesh inference is unavailable. Check Wallet and your connection, then try again.';
  } else if (provider === 'mesh-llm') {
    message =
      'No public mesh node is available. Try again, or choose ChatGPT under General → Inference.';
  }
  return new SigDemoAgentRuntimeError(message, 'node-unavailable');
}

export type SigDemoAgentFailureContextType = Readonly<{
  provider: SigDemoInferenceProviderType;
  phase: string;
  model?: string;
  nodeId?: string;
  diagnosticId?: string;
}>;

/** Bounded support fields only; no URLs, provider bodies, or chat identifiers. */
export function sigDemoAgentFailureDetails(
  error: unknown,
  context: SigDemoAgentFailureContextType
): Readonly<{
  provider: SigDemoInferenceProviderType;
  phase: string;
  errorCode: SigDemoAgentErrorCodeType;
  httpStatus?: number;
  reasonCode?: string;
  model?: string;
  nodeId?: string;
  diagnosticId?: string;
}> {
  const { model, nodeId } = context;
  return {
    provider: context.provider,
    phase: phases.has(context.phase) ? context.phase : 'runtime-starting',
    ...(context.diagnosticId && /^[a-f0-9]{8}$/i.test(context.diagnosticId)
      ? { diagnosticId: context.diagnosticId.toLowerCase() }
      : {}),
    errorCode: sigDemoAgentErrorCode(error),
    ...(error instanceof SigDemoAgentRuntimeError && error.httpStatus != null
      ? { httpStatus: error.httpStatus }
      : {}),
    ...(error instanceof SigDemoAgentRuntimeError && error.reasonCode
      ? { reasonCode: error.reasonCode }
      : {}),
    ...(model &&
    model.length <= 96 &&
    /^[a-z0-9][a-z0-9._:/+#-]*$/i.test(model) &&
    !model.includes('://') &&
    !/(?:^sk-|^gsk_|^BSA|api.?key|secret|credential|token)/i.test(model)
      ? { model }
      : {}),
    ...(nodeId && /^[a-f0-9]{64}$/i.test(nodeId)
      ? { nodeId: nodeId.slice(0, 10).toLowerCase() }
      : {}),
  };
}

/** The same safe fields appear in the failed reply and the local main log. */
export function formatSigDemoAgentFailure(
  error: unknown,
  details: ReturnType<typeof sigDemoAgentFailureDetails>
): string {
  const fields = [
    `code=${details.errorCode}`,
    ...(details.httpStatus != null ? [`HTTP ${details.httpStatus}`] : []),
    ...(details.reasonCode ? [`reason=${details.reasonCode}`] : []),
    `provider=${details.provider}`,
    ...(details.model ? [`model=${details.model}`] : []),
    ...(details.nodeId ? [`node=${details.nodeId}`] : []),
    `phase=${details.phase}`,
    ...(details.diagnosticId ? [`ref=${details.diagnosticId}`] : []),
  ];
  return `${safeSigDemoAgentError(error)}\n\nDetails: ${fields.join('; ')}`;
}
