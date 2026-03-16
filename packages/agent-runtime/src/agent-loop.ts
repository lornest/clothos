import type {
  AgentEvent,
  AgentLoopOptions,
  CompletionOptions,
  ToolDefinition,
} from '@clothos/core';
import type { ConversationContext } from './conversation-context.js';
import type { HookRegistry } from './hook-registry.js';
import type { LLMService } from './llm-service.js';
import type { ToolHandlerMap } from './tool-executor.js';
import type { AssembledContext, ToolCallHookResult } from './types.js';
import { HookBlockError } from './errors.js';
import { executeToolCall } from './tool-executor.js';

const MAX_TOOL_OUTPUT_CHARS = 50_000;

function truncateToolOutput(output: unknown, maxChars: number): string {
  const json = JSON.stringify(output);
  if (json.length <= maxChars) return json;
  return json.slice(0, maxChars) + `\n[truncated: ${json.length.toLocaleString()} chars, showing first ${maxChars.toLocaleString()}]`;
}

export async function* agentLoop(
  llm: LLMService,
  context: ConversationContext,
  tools: ToolDefinition[],
  toolHandlers: ToolHandlerMap,
  hooks: HookRegistry,
  options: AgentLoopOptions = {},
): AsyncGenerator<AgentEvent> {
  const maxTurns = options.maxTurns ?? 100;
  let turn = 0;

  try {
    await hooks.fire('before_agent_start', { context });

    while (true) {
      turn++;
      if (turn > maxTurns) {
        yield { type: 'max_turns_reached', turns: maxTurns };
        break;
      }

      await hooks.fire('turn_start', { turn, context });

      // Assemble context via hook (allows plugins to inject/modify)
      const defaultAssembled: AssembledContext = {
        messages: context.getMessages(),
        options: context.getOptions(),
      };
      const assembled = (await hooks.fire(
        'context_assemble',
        defaultAssembled,
      )) as AssembledContext;

      const messages = assembled?.messages ?? defaultAssembled.messages;
      const completionOptions: CompletionOptions =
        assembled?.options ?? defaultAssembled.options;

      // Call LLM
      const response = await llm.streamCompletion(
        messages,
        tools,
        completionOptions,
      );

      // Yield assistant message and add to context
      yield { type: 'assistant_message', content: response };
      context.addAssistantMessage(response.text, response.toolCalls);

      // If no tool calls, natural completion
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      // Process tool calls
      for (const call of response.toolCalls) {
        // Check hook for blocking
        let blocked = false;
        let blockReason = '';
        try {
          const hookResult = (await hooks.fire('tool_call', {
            name: call.name,
            arguments: call.arguments,
          })) as ToolCallHookResult | undefined;

          if (hookResult?.blocked) {
            blocked = true;
            blockReason = hookResult.reason ?? 'Blocked by hook';
          }
        } catch (err) {
          if (err instanceof HookBlockError) {
            blocked = true;
            blockReason = err.reason;
          } else {
            throw err;
          }
        }

        if (blocked) {
          yield { type: 'tool_blocked', name: call.name, reason: blockReason };
          context.addToolResult(
            call.id,
            JSON.stringify({ error: `Tool blocked: ${blockReason}` }),
          );
          continue;
        }

        // Execute tool
        await hooks.fire('tool_execution_start', { name: call.name });
        const result = await executeToolCall(call, toolHandlers);
        await hooks.fire('tool_execution_end', {
          name: call.name,
          result,
        });

        const resultJson = truncateToolOutput(result.output, MAX_TOOL_OUTPUT_CHARS);
        yield { type: 'tool_result', name: call.name, toolCallId: call.id, result: resultJson };
        context.addToolResult(call.id, resultJson);
      }

      await hooks.fire('turn_end', { turn, context });
    }

    await hooks.fire('agent_end', { context });
  } catch (err) {
    yield { type: 'error', error: err };
  }
}
