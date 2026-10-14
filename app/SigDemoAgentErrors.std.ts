// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

const ERROR_CODES = [
  'application-error',
  'rate-limited',
  'output-token-limit',
  'context-length',
  'authentication',
  'timeout',
  'provider-unavailable',
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

/** Messages constructed by the application, safe to display without SDK details. */
export class SigDemoAgentRuntimeError extends Error {
  readonly code: SigDemoAgentErrorCodeType;

  constructor(message: string, code?: SigDemoAgentErrorCodeType) {
    super(message);
    // Untyped callers cannot put provider diagnostics into a logging field.
    this.code = code && allowedCodes.has(code) ? code : 'application-error';
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
