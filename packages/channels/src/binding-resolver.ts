import type { Binding, ResolvedBinding } from '@clothos/core';

/**
 * Resolves the best-matching agent for a given channel/sender/conversation
 * by scoring against the configured Binding[] list.
 *
 * Scoring:
 *  - priority (base score, default 0)
 *  - peer match:    +4
 *  - team match:    +2
 *  - account match: +2
 *  - channel match: +1
 *
 * Highest score wins. Falls back to channel:'default' binding.
 */
export function resolveAgent(
  bindings: Binding[],
  channelType: string,
  senderId: string,
  conversationId?: string,
): ResolvedBinding {
  let bestScore = -1;
  let bestBinding: Binding | undefined;

  for (const binding of bindings) {
    let score = binding.priority ?? 0;
    let matches = true;

    if (binding.peer !== undefined) {
      if (binding.peer === senderId) {
        score += 4;
      } else {
        matches = false;
      }
    }

    if (binding.team !== undefined) {
      if (binding.team === conversationId) {
        score += 2;
      } else {
        matches = false;
      }
    }

    if (binding.account !== undefined) {
      // Account matches are for the bot account within a platform — not scored here
      // since we don't track account IDs in inbound messages currently.
      // Include as a tiebreaker when present.
      score += 2;
    }

    if (binding.channel !== undefined) {
      if (binding.channel === channelType || binding.channel === 'default') {
        score += binding.channel === channelType ? 1 : 0;
      } else {
        matches = false;
      }
    }

    if (matches && score > bestScore) {
      bestScore = score;
      bestBinding = binding;
    }
  }

  if (bestBinding) {
    return { agentId: bestBinding.agentId, binding: bestBinding };
  }

  // Fallback: find a channel:'default' binding
  const defaultBinding = bindings.find((b) => b.channel === 'default');
  if (defaultBinding) {
    return { agentId: defaultBinding.agentId, binding: defaultBinding };
  }

  throw new Error(
    `No binding found for channel="${channelType}" sender="${senderId}"`,
  );
}
