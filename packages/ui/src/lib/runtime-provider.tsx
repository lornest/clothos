import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import {
  useExternalStoreRuntime,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { GatewayWsClient, type AgentMessage } from './ws-client.js';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function getOrCreateSenderId(): string {
  const key = 'agentic-os:senderId';
  let id = localStorage.getItem(key);
  if (!id) {
    id = `user-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

const senderId = getOrCreateSenderId();

export function GatewayRuntimeProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const clientRef = useRef<GatewayWsClient | null>(null);
  const pendingRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string | null>(
    localStorage.getItem('agentic-os:sessionId'),
  );

  useEffect(() => {
    const client = new GatewayWsClient();
    clientRef.current = client;

    // Pass auth token from URL query string (e.g. ?token=change-me)
    const urlToken = new URLSearchParams(location.search).get('token') ?? undefined;

    client.connect(
      (msg: AgentMessage) => {
        const correlationId = msg.correlationId ?? msg.id;

        if (!pendingRef.current.has(correlationId)) return;

        const isDone = msg.type === 'task.done' || msg.type === 'task.error';

        if (isDone) {
          pendingRef.current.delete(correlationId);
          setIsRunning(false);
          return;
        }

        const data = msg.data as Record<string, unknown> | undefined;

        if (data?.sessionId && typeof data.sessionId === 'string') {
          sessionIdRef.current = data.sessionId;
          localStorage.setItem('agentic-os:sessionId', data.sessionId);
        }

        const text =
          typeof data?.text === 'string' ? data.text : JSON.stringify(data);

        const assistantMessage: ThreadMessageLike = {
          role: 'assistant',
          content: [{ type: 'text', text }],
        };

        setMessages((prev) => [...prev, assistantMessage]);
      },
      undefined,
      urlToken,
    );

    return () => {
      client.close();
    };
  }, []);

  const onNew = useCallback(async (message: AppendMessage) => {
    const textPart = message.content.find((c) => c.type === 'text');
    if (!textPart || textPart.type !== 'text') return;

    const text = textPart.text;

    const userMessage: ThreadMessageLike = {
      role: 'user',
      content: [{ type: 'text', text }],
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsRunning(true);

    const correlationId = generateId();
    pendingRef.current.add(correlationId);

    // Parse /plan command and send structured metadata
    const planMatch = text.match(/^\/plan\s+(\S+)(?:\s+(.+))?$/s);
    let messageText = text;
    let extraMetadata: Record<string, string> = {};

    if (planMatch) {
      const slug = planMatch[1]!;
      const goal = planMatch[2]?.trim();
      extraMetadata = { 'x-plan-mode': 'true', 'x-plan-slug': slug };
      messageText = goal
        ? `Plan the following task: ${goal}`
        : `Explore the codebase and create an implementation plan for: ${slug}`;
    }

    const agentMsg: AgentMessage = {
      id: generateId(),
      specversion: '1.0',
      type: 'task.request',
      source: `channel://webchat/${senderId}`,
      target: 'agent://assistant',
      time: now(),
      datacontenttype: 'application/json',
      data: { text: messageText, sessionId: sessionIdRef.current ?? undefined },
      correlationId,
      metadata: {
        channelType: 'webchat',
        senderId,
        ...extraMetadata,
      },
    };

    clientRef.current?.send(agentMsg);
  }, []);

  const handleSetMessages = useCallback(
    (msgs: readonly ThreadMessageLike[]) => {
      setMessages([...msgs]);
    },
    [],
  );

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    setMessages: handleSetMessages,
    onNew,
    convertMessage: (m: ThreadMessageLike) => m,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
