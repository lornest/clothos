import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { ConnectionStatus, ChatMessage } from '../types.js';
import { StatusBar } from './status-bar.js';
import { MessageList } from './message-list.js';
import { MessageInput } from './message-input.js';
import { ContextBar } from './context-bar.js';
import { useContextInfo } from '../hooks/use-context-info.js';

interface ChatViewProps {
  connectionStatus: ConnectionStatus;
  agentId: string;
  messages: ChatMessage[];
  isLoading: boolean;
  sessionId?: string;
  onSubmit: (input: string) => void;
}

export function ChatView({ connectionStatus, agentId, messages, isLoading, sessionId, onSubmit }: ChatViewProps) {
  const context = useContextInfo(messages);
  const [inputFocused, setInputFocused] = useState(true);

  useKeyboard((key) => {
    if (key.name === 'tab') {
      setInputFocused((prev) => !prev);
    }
  });

  return (
    <box flexDirection="column" height="100%">
      <StatusBar connectionStatus={connectionStatus} sessionId={sessionId} />
      <box flexGrow={1} flexDirection="column" padding={1}>
        <MessageList messages={messages} focused={!inputFocused} />
      </box>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
        <MessageInput onSubmit={onSubmit} isLoading={isLoading} focused={inputFocused} agentId={agentId} />
        <ContextBar context={context} />
      </box>
    </box>
  );
}
