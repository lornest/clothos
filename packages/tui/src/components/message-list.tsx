import type { ChatMessage } from '../types.js';
import { ToolCallView } from './tool-call.js';
import { ThinkingBlock } from './thinking-block.js';
import { ACCENT_BORDER } from '../lib/borders.js';

interface MessageListProps {
  messages: ChatMessage[];
  focused?: boolean;
}

export function MessageList({ messages, focused = false }: MessageListProps) {
  return (
    <scrollbox focused={focused} style={{ flexGrow: 1 }}>
      {messages.map((msg) => {
        const isUser = msg.role === 'user';

        return (
          <box key={msg.id} flexDirection="column" marginBottom={1}>
            {/* Thinking/reasoning block — shown above the assistant's response */}
            {msg.thinking && (
              <ThinkingBlock content={msg.thinking} />
            )}

            {isUser ? (
              /* User messages — accent-bordered box matching the input area */
              <box
                border={['left'] as any}
                borderColor="#E8A84B"
                customBorderChars={ACCENT_BORDER as any}
                backgroundColor="#333333"
                paddingLeft={1}
                paddingRight={1}
                marginLeft={0}
              >
                <text fg="white" wrapMode="word">{msg.content}</text>
              </box>
            ) : (
              /* Assistant / system messages — plain text */
              <box paddingLeft={2} paddingRight={1} flexDirection="column">
                <text wrapMode="word">{msg.content}</text>
              </box>
            )}

            {/* Tool calls rendered as "thinking" quote blocks */}
            {msg.toolCalls?.map((tc, i) => (
              <box key={i} marginTop={0} marginBottom={0}>
                <ToolCallView toolCall={tc} />
              </box>
            ))}
          </box>
        );
      })}
    </scrollbox>
  );
}
