// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

/** Messages constructed by the application, safe to display without SDK details. */
export class SigDemoAgentRuntimeError extends Error {}

/** SDK diagnostics may contain chat text or secrets. Only expose classifications. */
export function safeSigDemoAgentError(error: unknown): string {
  if (error instanceof SigDemoAgentRuntimeError) {
    return error.message;
  }
  const kind =
    error != null && typeof error === 'object' && 'kind' in error
      ? error.kind
      : undefined;
  switch (kind) {
    case 'RateLimited':
      return 'Sig is busy. Try again shortly.';
    case 'OutputTokenLimitExceeded':
      return "Sig's response exceeded the output limit.";
    case 'ContextLengthExceeded':
      return 'The submitted message is too long for this model.';
    case 'Authentication':
      return "Sig's API credential was rejected.";
    case 'Timeout':
      return "Sig's request timed out. Try again.";
    case 'ProviderUnavailable':
      return "Sig's model provider is unavailable.";
    case 'Generic': {
      const details =
        'details' in (error as object) &&
        typeof (error as { details: unknown }).details === 'string'
          ? (error as { details: string }).details.toLowerCase()
          : '';
      return details.includes('model_not_found') ||
        details.includes('does not exist')
        ? 'The configured Sig model is unavailable for this API key.'
        : 'Sig could not complete the request. Try again.';
    }
    default:
      return 'Sig could not complete the request. Try again.';
  }
}
