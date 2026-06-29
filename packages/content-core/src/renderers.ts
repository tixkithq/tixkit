/**
 * Deterministic render pipeline (C-088).
 *
 * Server-safe renderers for event page HTML, email HTML/text, and SMS text.
 * Reuses the @tixkit/domain merge-tag engine with channel-specific escaping
 * and fallbacks so that preview, test-send, and real send output match by
 * content version. Renderer output never calls provider APIs directly.
 */

import {
  renderMergeTags,
  countSmsSegments,
  injectOptOutToken,
  type MergeTagContext,
} from '@tixkit/domain';
import type { ContentChannel, RenderContract } from './index.js';

export type RenderInput = {
  channel: ContentChannel;
  contract: RenderContract;
  /** Canonical content (already-fetched published version). */
  subject?: string;
  html?: string;
  text?: string;
  /** Per-recipient context for personalization. */
  context: MergeTagContext;
  /** SMS opt-out token, required for bulk/marketing SMS. */
  optOutToken?: string;
};

export type RenderOutput = {
  subject?: string;
  html?: string;
  text?: string;
  segments?: number;
};

/**
 * Render a content version for a specific recipient. Deterministic: the same
 * (content, context) always yields the same output, so preview equals send.
 */
export function renderContent(input: RenderInput): RenderOutput {
  const { channel, contract, context } = input;

  if (channel === 'email') {
    return {
      subject: renderMergeTags(input.subject ?? '', context, { channel: 'email', escape: 'plain' }),
      html: renderMergeTags(input.html ?? '', context, { channel: 'email', escape: 'html' }),
      text: input.text
        ? renderMergeTags(input.text, context, { channel: 'email', escape: 'plain' })
        : undefined,
    };
  }

  if (channel === 'sms') {
    const body = input.text ?? '';
    const withOptOut = contract.supportsOptOut && input.optOutToken
      ? renderMergeTags(body, context, { channel: 'sms', escape: 'plain', optOutToken: input.optOutToken })
      : renderMergeTags(body, context, { channel: 'sms', escape: 'plain' });
    const segments = contract.supportsSegmentAccounting ? countSmsSegments(withOptOut).segments : undefined;
    return { text: withOptOut, segments };
  }

  if (channel === 'event_page') {
    return {
      html: renderMergeTags(input.html ?? '', context, { channel: 'email', escape: 'html' }),
    };
  }

  // Stubbed/future channels: fail closed (no rendering yet).
  throw new Error(`Rendering is not implemented for channel ${channel}`);
}

/** Preview equals send: render with a sample context for the admin preview. */
export function renderPreview(
  channel: ContentChannel,
  contract: RenderContract,
  content: { subject?: string; html?: string; text?: string },
  sampleContext: MergeTagContext,
  optOutToken?: string,
): RenderOutput {
  return renderContent({ channel, contract, context: sampleContext, optOutToken, ...content });
}

/** Check that a body is within an SMS segment budget (used at publish + send). */
export function withinSmsSegmentBudget(text: string, limit = 10): boolean {
  return countSmsSegments(text).segments <= limit;
}

// Re-export for callers that need the opt-out helper directly.
export { injectOptOutToken };
