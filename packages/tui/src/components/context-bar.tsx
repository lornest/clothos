import type { ContextInfo } from '../types.js';
import { truncate } from '../lib/format.js';

interface ContextBarProps {
  context: ContextInfo;
}

const SEPARATOR = ' \u2502 ';

export function ContextBar({ context }: ContextBarProps) {
  const { cwd, gitBranch, gitDirty, activeFiles } = context;

  return (
    <box paddingLeft={1} paddingRight={1}>
      <box flexGrow={1}>
        <text>
          <span fg="#888888">{cwd}</span>

          {gitBranch != null && (
            <>
              <span fg="#888888">{SEPARATOR}</span>
              <span fg={gitDirty ? 'yellow' : 'green'}>
                {gitBranch}
                {gitDirty ? '*' : ''}
              </span>
            </>
          )}

          <span fg="#888888">{SEPARATOR}files: </span>
          <span fg="#888888">
            {activeFiles.length > 0
              ? truncate(activeFiles.join(', '), 60)
              : 'none'}
          </span>
        </text>
      </box>
    </box>
  );
}
