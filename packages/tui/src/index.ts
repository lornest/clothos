export { App } from './app.js';
export type { AppProps } from './app.js';

export { ChatView } from './components/chat-view.js';
export { MessageList } from './components/message-list.js';
export { MessageInput } from './components/message-input.js';
export { StatusBar } from './components/status-bar.js';
export { ToolCallView } from './components/tool-call.js';
export { ContextBar } from './components/context-bar.js';

export { useGateway } from './hooks/use-gateway.js';
export type { UseGatewayOptions, UseGatewayResult } from './hooks/use-gateway.js';
export { useChat } from './hooks/use-chat.js';
export type { UseChatOptions, UseChatResult } from './hooks/use-chat.js';
export { useContextInfo } from './hooks/use-context-info.js';

export { createTaskRequest } from './lib/message-factory.js';
export { roleLabel, roleColor, colorize, truncate } from './lib/format.js';

export type { ChatMessage, ChatMessageRole, ConnectionStatus, ToolCallDisplay, ContextInfo } from './types.js';
