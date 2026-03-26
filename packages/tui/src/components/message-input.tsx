import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useRef } from 'react';
import { ACCENT_BORDER } from '../lib/borders.js';

interface MessageInputProps {
  onSubmit: (value: string) => void;
  isLoading: boolean;
  focused?: boolean;
  agentId?: string;
}

export function MessageInput({ onSubmit, isLoading, focused = true, agentId }: MessageInputProps) {
  const textareaRef = useRef<TextareaRenderable>(null);

  useKeyboard((key) => {
    if (!focused || isLoading) return;
    if (key.name === 'return' && key.eventType === 'press') {
      const text = textareaRef.current?.plainText ?? '';
      if (text.trim()) {
        onSubmit(text);
        textareaRef.current?.clear();
      }
    }
  });

  return (
    <box flexDirection="column">
      {/* Textarea with agent label inside and left accent border */}
      <box
        border={['left'] as any}
        borderColor={isLoading ? '#888888' : '#E8A84B'}
        customBorderChars={ACCENT_BORDER as any}
        backgroundColor="#333333"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
        paddingBottom={0}
        flexDirection="column"
        minHeight={5}
      >
        {/* Input area */}
        {isLoading ? (
          <text fg="#888888">
            <em>Agent is thinking...</em>
          </text>
        ) : (
          <textarea
            ref={textareaRef}
            placeholder="Message..."
            focused={focused}
            style={{
              minHeight: 2,
              maxHeight: 12,
              flexGrow: 1,
            }}
          />
        )}

        {/* Agent name label at bottom of input area */}
        <box marginTop={0} flexShrink={0} height={1}>
          <text>
            <span fg="#E8A84B">{agentId ?? 'assistant'}</span>
          </text>
        </box>
      </box>

      {/* Footer hints */}
      <box
        paddingLeft={2}
        paddingRight={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text>
          <span fg="#888888">{isLoading ? 'working...' : 'Enter to send'}</span>
        </text>
        <text>
          <span fg="#555555">Tab scroll</span>
        </text>
      </box>
    </box>
  );
}
