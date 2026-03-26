import { useGateway } from './hooks/use-gateway.js';
import { useChat } from './hooks/use-chat.js';
import { ChatView } from './components/chat-view.js';

export interface AppProps {
  url: string;
  token?: string;
  agentId: string;
}

export function App({ url, token, agentId }: AppProps) {
  const gateway = useGateway({ url, token });
  const { messages, isLoading, sessionId, send } = useChat({
    agentId,
    gateway,
    onQuit: () => process.exit(0),
  });

  return (
    <ChatView
      connectionStatus={gateway.status}
      agentId={agentId}
      messages={messages}
      isLoading={isLoading}
      sessionId={sessionId}
      onSubmit={send}
    />
  );
}
