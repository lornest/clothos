import { ACCENT_BORDER_CONTINUOUS } from '../lib/borders.js';
import { truncate } from '../lib/format.js';

interface ThinkingBlockProps {
  content: string;
}

export function ThinkingBlock({ content }: ThinkingBlockProps) {
  // Extract a short summary from the first line for the header
  const firstLine = content.split('\n')[0] ?? '';
  const summary = truncate(firstLine.trim(), 60);

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
      {/* Header */}
      <text>
        <em fg="#E8A84B">{'Thinking: '}</em>
        <strong fg="#E8A84B">{summary}</strong>
      </text>

      {/* Reasoning content — muted, word-wrapped */}
      <box marginTop={0}>
        <text fg="#999999" wrapMode="word">
          {truncate(content, 500)}
        </text>
      </box>
    </box>
  );
}
