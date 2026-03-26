import type { ConnectionStatus } from '../types.js';

interface StatusBarProps {
  connectionStatus: ConnectionStatus;
  sessionId?: string;
}

const STATUS_INDICATOR: Record<ConnectionStatus, { dot: string; color: string; label: string }> = {
  connected:    { dot: '\u25cf', color: 'green', label: 'CONNECTED' },
  connecting:   { dot: '\u25cf', color: 'yellow', label: 'CONNECTING' },
  disconnected: { dot: '\u25cf', color: 'red', label: 'OFFLINE' },
  error:        { dot: '!', color: 'red', label: 'ERROR' },
};

export function StatusBar({ connectionStatus, sessionId }: StatusBarProps) {
  const { dot, color, label } = STATUS_INDICATOR[connectionStatus];

  return (
    <box paddingLeft={1} paddingRight={1} justifyContent="space-between">
      <box>
        <text>
          <strong fg={color}>{dot} {label}</strong>
        </text>
      </box>
      <box>
        {sessionId && (
          <text>
            <span fg="#888888">{'session: '}</span>
            <span fg="magenta">{sessionId.slice(0, 8)}</span>
          </text>
        )}
      </box>
    </box>
  );
}
