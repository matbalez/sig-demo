// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { v5 as uuidV5 } from 'uuid';

export const sigDemoAgentFrameSchema = z.object({
  queryId: z.uuid(),
  queryTimestamp: z.number().int().positive(),
  sequence: z.number().int().nonnegative().max(0xffffffff),
  status: z.enum(['streaming', 'complete', 'error']),
  text: z.string().max(65536),
});

export type SigDemoAgentFrame = z.infer<typeof sigDemoAgentFrameSchema>;
export type SigDemoAgentResponse = Omit<SigDemoAgentFrame, 'text'>;

export function parseSigDemoAgentFrame(
  value: unknown
): SigDemoAgentFrame | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const result = sigDemoAgentFrameSchema.safeParse({
    ...input,
    queryTimestamp:
      typeof input.queryTimestamp === 'bigint'
        ? Number(input.queryTimestamp)
        : input.queryTimestamp,
  });
  return result.success ? result.data : undefined;
}

export function extractSigDemoAgentPrompt(
  body: string | undefined
): string | undefined {
  if (!body) {
    return undefined;
  }
  const match = /(^|\s)@sig(?=$|\s|[.,!?;:])/i.exec(body);
  if (!match) {
    return undefined;
  }
  return `${body.slice(0, match.index)}${match[1]}${body.slice(match.index + match[0].length)}`.trim();
}

const SIG_BUBBLE_NAMESPACE = 'b5d535bf-7121-4e16-9a6d-044c3946a7e9';

export function getSigDemoAgentBubbleId(
  conversationId: string,
  originAci: string,
  queryId: string
): string {
  return uuidV5(
    `${conversationId}/${originAci}/${queryId}`,
    SIG_BUBBLE_NAMESPACE
  );
}

export function shouldApplySigDemoAgentFrame(
  previous: SigDemoAgentResponse | undefined,
  next: SigDemoAgentFrame
): boolean {
  if (!previous) {
    return true;
  }
  return (
    previous.queryId === next.queryId &&
    previous.queryTimestamp === next.queryTimestamp &&
    previous.status === 'streaming' &&
    next.sequence > previous.sequence
  );
}
