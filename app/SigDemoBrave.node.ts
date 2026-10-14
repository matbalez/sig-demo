// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'node:buffer';
import { SigDemoAgentRuntimeError } from './SigDemoAgentErrors.std.ts';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/llm/context';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 6000;

export type SearchArguments = Readonly<{
  query: string;
  freshness?: 'pd' | 'pw' | 'pm' | 'py';
}>;

export type SearchResult = Readonly<{
  query: string;
  sources: ReadonlyArray<
    Readonly<{ title: string; url: string; text: string }>
  >;
  error?: string;
}>;

export function truncateUtf8(text: string, byteLimit: number): string {
  let bytes = 0;
  let result = '';
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > byteLimit) {
      break;
    }
    result += character;
  }
  return result;
}

export function searchFailure(query: string, error: string): SearchResult {
  return { query: truncateUtf8(query, 2400), sources: [], error };
}

export function parseSearchArguments(value: unknown): SearchArguments {
  if (
    value == null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => key !== 'query' && key !== 'freshness') ||
    !('query' in value) ||
    typeof value.query !== 'string'
  ) {
    throw new SigDemoAgentRuntimeError(
      'Sig returned invalid web search arguments. Please try again.'
    );
  }
  const { query } = value;
  if (
    query.trim().length === 0 ||
    Array.from(query).length > 600 ||
    query.trim().split(/\p{White_Space}+/u).length > 75 ||
    /\p{Cc}/u.test(query)
  ) {
    throw new SigDemoAgentRuntimeError(
      'The web search query is invalid or too long.'
    );
  }
  const freshness = 'freshness' in value ? value.freshness : undefined;
  if (freshness == null) {
    return { query };
  }
  if (
    freshness !== 'pd' &&
    freshness !== 'pw' &&
    freshness !== 'pm' &&
    freshness !== 'py'
  ) {
    throw new SigDemoAgentRuntimeError(
      'The web search freshness filter is invalid.'
    );
  }
  return { query, freshness };
}

export function isBraveToolName(name: string): boolean {
  return (
    name === 'brave_web_search' ||
    name === 'google_search' ||
    name === 'search' ||
    name === 'web_search'
  );
}

function normalize(query: string, value: unknown): SearchResult {
  if (
    value == null ||
    typeof value !== 'object' ||
    !('grounding' in value) ||
    value.grounding == null ||
    typeof value.grounding !== 'object' ||
    !('generic' in value.grounding) ||
    !Array.isArray(value.grounding.generic)
  ) {
    throw new Error('Web search returned an unreadable result.');
  }
  const sources: Array<{ title: string; url: string; text: string }> = [];
  const result = { query, sources };
  for (const item of value.grounding.generic.slice(0, 5)) {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string') {
      continue;
    }
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      Buffer.byteLength(item.url) > 2048
    ) {
      continue;
    }
    const snippets = Array.isArray(item.snippets)
      ? item.snippets
          .filter(
            (snippet: unknown): snippet is string => typeof snippet === 'string'
          )
          .slice(0, 3)
          .join('\n')
      : '';
    sources.push({
      title: truncateUtf8(
        typeof item.title === 'string' ? item.title : 'Source',
        180
      ),
      url: item.url,
      text: truncateUtf8(snippets, 1000),
    });
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
      const last = sources.at(-1);
      if (!last) {
        break;
      }
      const textBytes = Buffer.byteLength(last.text);
      if (textBytes > 100) {
        last.text = truncateUtf8(last.text, textBytes - 100);
      } else {
        sources.pop();
        break;
      }
    }
  }
  return result;
}

export class BraveSearch {
  readonly #key: string;
  readonly #endpoint: string;

  // Only tests override the endpoint; agent/model input never controls it.
  constructor(key: string, endpoint = BRAVE_ENDPOINT) {
    if (!/^[\u0021-\u007e]{1,1024}$/.test(key)) {
      throw new SigDemoAgentRuntimeError('The search credential is invalid.');
    }
    this.#key = key;
    this.#endpoint = endpoint;
  }

  async search(
    arguments_: SearchArguments,
    signal: AbortSignal
  ): Promise<SearchResult> {
    let failure = 'Web search could not connect. Try again.';
    try {
      const argumentsValidated = parseSearchArguments(arguments_);
      signal.throwIfAborted();
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Subscription-Token': this.#key,
        },
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        body: JSON.stringify({
          q: argumentsValidated.query,
          count: 5,
          maximum_number_of_urls: 5,
          maximum_number_of_tokens: 2048,
          safesearch: 'moderate',
          ...(argumentsValidated.freshness && {
            freshness: argumentsValidated.freshness,
          }),
        }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          'The web search credential or API access was rejected.'
        );
      }
      if (response.status === 429) {
        throw new Error('Web search is busy or its quota is exhausted.');
      }
      if (!response.ok) {
        throw new Error('Web search is temporarily unavailable.');
      }
      failure = 'Web search returned an unreadable result.';
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error(failure);
      }
      const chunks: Array<Uint8Array<ArrayBuffer>> = [];
      let length = 0;
      try {
        let complete = false;
        while (!complete) {
          signal.throwIfAborted();
          // Each read depends on the previous stream chunk and byte budget.
          // oxlint-disable-next-line no-await-in-loop
          const next = await reader.read();
          complete = next.done;
          if (next.value) {
            length += next.value.byteLength;
            if (length > MAX_RESPONSE_BYTES) {
              failure = 'Web search returned too much data.';
              // Stop reading as soon as the response exceeds the bounded budget.
              // oxlint-disable-next-line no-await-in-loop
              await reader.cancel();
              throw new Error(failure);
            }
            chunks.push(next.value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      return normalize(
        argumentsValidated.query,
        JSON.parse(Buffer.concat(chunks).toString('utf8'))
      );
    } catch (error) {
      // Cancellation must stop the agent before it requests another model turn.
      signal.throwIfAborted();
      const allowed = new Set([
        'The web search query is invalid or too long.',
        'The web search freshness filter is invalid.',
        'Sig returned invalid web search arguments. Please try again.',
        'The web search credential or API access was rejected.',
        'Web search is busy or its quota is exhausted.',
        'Web search is temporarily unavailable.',
        'Web search returned too much data.',
      ]);
      return searchFailure(
        arguments_.query,
        error instanceof Error && allowed.has(error.message)
          ? error.message
          : failure
      );
    }
  }
}
