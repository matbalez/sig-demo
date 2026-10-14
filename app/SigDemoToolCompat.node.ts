// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

// A private bounded frame accumulator belongs to this streaming filter.
/* oxlint-disable max-classes-per-file */

import { Buffer } from 'node:buffer';
import { SigDemoAgentRuntimeError } from './SigDemoAgentErrors.std.ts';
import { isBraveToolName, parseSearchArguments } from './SigDemoBrave.node.ts';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';
const MAX_FRAME_BYTES = 8 * 1024;
const MAX_FRAMES = 8;
const INVALID_CALL =
  'Sig returned an unreadable web search request. Try again.';
const UNSUPPORTED_CALL =
  'Sig requested an unavailable tool. Only web search is available.';

export type CompatToolCall = Readonly<{ name: string; argumentsJson: string }>;

class Frame {
  bytes = OPEN;
  totalBytes = Buffer.byteLength(OPEN);
  closingProbe = '';
  oversized = false;

  push(character: string): boolean {
    this.totalBytes += Buffer.byteLength(character);
    if (this.totalBytes > MAX_FRAME_BYTES) {
      this.oversized = true;
      this.bytes = '';
    } else if (!this.oversized) {
      this.bytes += character;
    }
    this.closingProbe += character;
    while (Buffer.byteLength(this.closingProbe) > CLOSE.length) {
      const first = Array.from(this.closingProbe)[0];
      this.closingProbe = this.closingProbe.slice(first?.length ?? 1);
    }
    return this.closingProbe === CLOSE;
  }
}

/** A bounded fallback for fresh model output; it never executes a tool. */
export class ToolTextFilter {
  #pending = '';
  #candidateIsStandalone = false;
  #frame: Frame | undefined;
  #framesSeen = 0;
  readonly #calls: Array<CompatToolCall> = [];
  #error: string | undefined;
  #lineHasText = false;
  #leadingIndent = 0;
  #delimiterCharacter: string | undefined;
  #delimiterLength = 0;
  #delimiterAtLineStart = false;
  #fence: Readonly<{ character: string; length: number }> | undefined;
  #pendingFenceClose = false;
  #inlineDelimiterLength: number | undefined;

  /** Normal text streams now, except an at most 11 byte possible-tag suffix. */
  push(text: string): string {
    let visible = '';
    for (const character of text) {
      if (this.#frame) {
        if (this.#frame.push(character)) {
          const frame = this.#frame;
          this.#frame = undefined;
          if (frame.oversized) {
            this.#error ??= INVALID_CALL;
          } else {
            try {
              const call = parseFrame(frame.bytes);
              if (this.#calls.length < MAX_FRAMES) {
                this.#calls.push(call);
              } else {
                this.#error ??= INVALID_CALL;
              }
            } catch (error) {
              this.#error ??=
                error instanceof SigDemoAgentRuntimeError
                  ? error.message
                  : INVALID_CALL;
            }
          }
        }
        continue;
      }
      if (!this.#pending) {
        this.#candidateIsStandalone = this.#isStandalone();
      }
      this.#pending += character;
      let pending = true;
      while (pending) {
        if (this.#pending === OPEN) {
          this.#pending = '';
          if (this.#candidateIsStandalone) {
            this.#framesSeen += 1;
            if (this.#framesSeen > MAX_FRAMES) {
              this.#error ??= INVALID_CALL;
            }
            this.#frame = new Frame();
          } else {
            visible += OPEN;
            this.#noteVisibleText(OPEN);
          }
          break;
        }
        if (this.#pending === CLOSE) {
          this.#pending = '';
          if (this.#candidateIsStandalone) {
            this.#error ??= INVALID_CALL;
          } else {
            visible += CLOSE;
            this.#noteVisibleText(CLOSE);
          }
          break;
        }
        if (
          this.#candidateIsStandalone &&
          this.#pending.startsWith('<tool_call') &&
          this.#pending.length > '<tool_call'.length
        ) {
          this.#error ??= INVALID_CALL;
          this.#pending = '';
          this.#frame = new Frame();
          break;
        }
        if (OPEN.startsWith(this.#pending) || CLOSE.startsWith(this.#pending)) {
          break;
        }
        const first = Array.from(this.#pending)[0] ?? '';
        this.#pending = this.#pending.slice(first.length);
        visible += first;
        this.#noteVisible(first);
        this.#candidateIsStandalone = this.#isStandalone();
        pending = this.#pending.length > 0;
      }
    }
    return visible;
  }

  /** Native SDK ToolChunks take precedence over these fallback calls/errors. */
  finish(): Readonly<{ tail: string; calls: ReadonlyArray<CompatToolCall> }> {
    if (this.#frame) {
      this.#error ??= INVALID_CALL;
    }
    const incompleteControl =
      this.#candidateIsStandalone &&
      (this.#pending.startsWith('<tool_') ||
        this.#pending.startsWith('</tool_'));
    if (incompleteControl) {
      this.#error ??= INVALID_CALL;
    }
    if (this.#error) {
      throw new SigDemoAgentRuntimeError(this.#error);
    }
    return { tail: incompleteControl ? '' : this.#pending, calls: this.#calls };
  }

  #isStandalone(): boolean {
    return (
      !this.#lineHasText &&
      this.#leadingIndent < 4 &&
      !this.#fence &&
      this.#inlineDelimiterLength === undefined
    );
  }

  #noteVisibleText(text: string): void {
    for (const character of text) {
      this.#noteVisible(character);
    }
  }

  #noteVisible(character: string): void {
    if (character === '`' || character === '~') {
      if (this.#delimiterCharacter === character) {
        this.#delimiterLength += 1;
      } else {
        this.#finishDelimiter();
        this.#delimiterCharacter = character;
        this.#delimiterLength = 1;
        this.#delimiterAtLineStart =
          !this.#lineHasText && this.#leadingIndent < 4;
      }
    } else {
      this.#finishDelimiter();
    }
    if (this.#pendingFenceClose) {
      if (character === '\n' || character === '\r') {
        this.#fence = undefined;
        this.#pendingFenceClose = false;
      } else if (character !== ' ' && character !== '\t') {
        this.#pendingFenceClose = false;
      }
    }
    if (character === '\n' || character === '\r') {
      this.#lineHasText = false;
      this.#leadingIndent = 0;
    } else if (
      !this.#lineHasText &&
      (character === ' ' || character === '\t')
    ) {
      this.#leadingIndent += character === '\t' ? 4 : 1;
    } else {
      this.#lineHasText = true;
    }
  }

  #finishDelimiter(): void {
    const character = this.#delimiterCharacter;
    this.#delimiterCharacter = undefined;
    if (!character) {
      return;
    }
    if (this.#fence) {
      if (
        this.#delimiterAtLineStart &&
        character === this.#fence.character &&
        this.#delimiterLength >= this.#fence.length
      ) {
        this.#pendingFenceClose = true;
      }
    } else if (this.#inlineDelimiterLength !== undefined) {
      if (
        character === '`' &&
        this.#delimiterLength === this.#inlineDelimiterLength
      ) {
        this.#inlineDelimiterLength = undefined;
      }
    } else if (this.#delimiterAtLineStart && this.#delimiterLength >= 3) {
      this.#fence = { character, length: this.#delimiterLength };
    } else if (character === '`') {
      this.#inlineDelimiterLength = this.#delimiterLength;
    }
  }
}

function takeElement(
  value: string,
  open: string,
  close: string
): Readonly<[string, string]> {
  if (!value.startsWith(open)) {
    throw new SigDemoAgentRuntimeError(INVALID_CALL);
  }
  const end = value.indexOf(close, open.length);
  if (end < 0) {
    throw new SigDemoAgentRuntimeError(INVALID_CALL);
  }
  return [value.slice(open.length, end), value.slice(end + close.length)];
}

function parseFrame(frame: string): CompatToolCall {
  if (!frame.startsWith(OPEN) || !frame.endsWith(CLOSE)) {
    throw new SigDemoAgentRuntimeError(INVALID_CALL);
  }
  const body = frame.slice(OPEN.length, -CLOSE.length).trim();
  let name: string;
  let arguments_: unknown;
  try {
    if (body.startsWith('{')) {
      const call: unknown = JSON.parse(body);
      if (
        call == null ||
        typeof call !== 'object' ||
        Array.isArray(call) ||
        Object.keys(call).some(key => key !== 'name' && key !== 'arguments') ||
        !('name' in call) ||
        typeof call.name !== 'string' ||
        !('arguments' in call)
      ) {
        throw new SigDemoAgentRuntimeError(INVALID_CALL);
      }
      name = call.name;
      arguments_ = call.arguments;
    } else {
      if (!body.startsWith('<function=')) {
        throw new SigDemoAgentRuntimeError(INVALID_CALL);
      }
      const end = body.indexOf('>');
      const wrapperName = body.slice('<function='.length, end);
      if (!isBraveToolName(wrapperName)) {
        throw new SigDemoAgentRuntimeError(UNSUPPORTED_CALL);
      }
      const wrapped = body.slice(end + 1).trim();
      if (!wrapped.endsWith('</function>')) {
        throw new SigDemoAgentRuntimeError(INVALID_CALL);
      }
      const [functionName, rest] = takeElement(
        wrapped.slice(0, -'</function>'.length).trim(),
        '<function_name>',
        '</function_name>'
      );
      const [argumentsJson, trailing] = takeElement(
        rest.trim(),
        '<function_arguments>',
        '</function_arguments>'
      );
      if (trailing.trim()) {
        throw new SigDemoAgentRuntimeError(INVALID_CALL);
      }
      name = functionName.trim();
      arguments_ = JSON.parse(argumentsJson.trim());
    }
  } catch (error) {
    throw error instanceof SigDemoAgentRuntimeError
      ? error
      : new SigDemoAgentRuntimeError(INVALID_CALL);
  }
  if (!isBraveToolName(name)) {
    throw new SigDemoAgentRuntimeError(UNSUPPORTED_CALL);
  }
  let validated;
  try {
    validated = parseSearchArguments(arguments_);
  } catch {
    throw new SigDemoAgentRuntimeError(INVALID_CALL);
  }
  return { name: 'brave_web_search', argumentsJson: JSON.stringify(validated) };
}
