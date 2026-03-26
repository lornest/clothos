import { useState, useCallback, useRef } from 'react';
import type { AgentMessage } from '@clothos/core';
import { generateId } from '@clothos/core';
import { createTaskRequest } from '../lib/message-factory.js';
import type { ChatMessage } from '../types.js';
import type { UseGatewayResult } from './use-gateway.js';

export interface UseChatOptions {
  agentId: string;
  gateway: UseGatewayResult;
  onQuit: () => void;
}

export interface UseChatResult {
  messages: ChatMessage[];
  isLoading: boolean;
  sessionId?: string;
  send: (input: string) => void;
}

export function useChat({ agentId, gateway, onQuit }: UseChatOptions): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(undefined);

  const send = useCallback((input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Handle slash commands
    if (trimmed === '/quit') {
      onQuit();
      return;
    }

    if (trimmed === '/clear') {
      setMessages([]);
      setSessionId(undefined);
      sessionIdRef.current = undefined;
      return;
    }

    // Append user message
    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: trimmed,
    };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);

    // Build and send task.request
    const request = createTaskRequest(agentId, trimmed, sessionIdRef.current);
    const correlationId = request.correlationId!;

    // Register response handler for this correlation
    gateway.onResponse(correlationId, (response: AgentMessage) => {
      const data = response.data as Record<string, unknown> | undefined;

      // Track session ID from agent responses
      if (data?.sessionId && typeof data.sessionId === 'string') {
        setSessionId(data.sessionId);
        sessionIdRef.current = data.sessionId;
      }

      // Terminal message types signal completion
      if (response.type === 'task.done' || response.type === 'task.error') {
        gateway.removeResponseHandler(correlationId);
        setIsLoading(false);

        if (response.type === 'task.error') {
          const errorText = typeof data?.error === 'string'
            ? data.error
            : 'Agent encountered an error';
          setMessages(prev => [...prev, {
            id: generateId(),
            role: 'system',
            content: errorText,
          }]);
        }
        return;
      }

      // Agent response with text content (and optional tool calls)
      if (response.type === 'task.response') {
        const text = typeof data?.text === 'string' ? data.text : JSON.stringify(data);

        // Extract tool calls if present (these represent the agent's "thinking" steps)
        const rawToolCalls = Array.isArray(data?.toolCalls) ? data.toolCalls : undefined;
        const toolCalls = rawToolCalls?.map((tc: Record<string, unknown>) => ({
          name: typeof tc.name === 'string' ? tc.name : 'unknown',
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? ''),
        }));

        // Extract thinking/reasoning content if present
        const thinking = typeof data?.thinking === 'string' ? data.thinking : undefined;

        setMessages(prev => [...prev, {
          id: generateId(),
          role: 'assistant',
          content: text,
          thinking,
          toolCalls,
        }]);
      }

      // Tool result — update the most recent assistant message's matching tool call with result
      if (response.type === 'task.tool_result') {
        const name = typeof data?.name === 'string' ? data.name : '';
        const result = typeof data?.result === 'string' ? data.result : JSON.stringify(data?.result ?? '');

        setMessages(prev => {
          const updated = [...prev];
          // Walk backward to find the assistant message with a matching tool call
          for (let i = updated.length - 1; i >= 0; i--) {
            const msg = updated[i]!;
            if (msg.role !== 'assistant' || !msg.toolCalls) continue;
            const tc = msg.toolCalls.find(t => t.name === name && !t.result);
            if (tc) {
              tc.result = result;
              break;
            }
          }
          return updated;
        });
      }
    });

    gateway.send(request);
  }, [agentId, gateway, onQuit]);

  return { messages, isLoading, sessionId, send };
}
