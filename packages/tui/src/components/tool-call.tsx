import type { ToolCallDisplay } from '../types.js';
import { truncate } from '../lib/format.js';
import { ACCENT_BORDER_CONTINUOUS } from '../lib/borders.js';

interface ToolCallProps {
  toolCall: ToolCallDisplay;
}

export function ToolCallView({ toolCall }: ToolCallProps) {
  return (
    <box
      border={['left'] as any}
      borderColor="#E8A84B"
      customBorderChars={ACCENT_BORDER_CONTINUOUS as any}
      backgroundColor="#2a2a2a"
      paddingLeft={1}
      paddingRight={1}
      marginLeft={1}
      flexDirection="column"
    >
      {/* Thinking header */}
      <text>
        <em fg="#E8A84B">{'Thinking: '}</em>
        <strong fg="#E8A84B">{toolCall.name}</strong>
      </text>

      {/* Thinking content — muted text */}
      {toolCall.arguments && (
        <box marginTop={0}>
          <text fg="#999999" wrapMode="word">
            {truncate(toolCall.arguments, 300)}
          </text>
        </box>
      )}

      {/* Result if available */}
      {toolCall.result != null && (
        <box marginTop={0}>
          <text fg="#999999" wrapMode="word">
            {truncate(toolCall.result, 300)}
          </text>
        </box>
      )}
    </box>
  );
}
