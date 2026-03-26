import { useState, useEffect, useMemo } from 'react';
import { execSync } from 'node:child_process';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import type { ChatMessage, ContextInfo } from '../types.js';

const REFRESH_MS = 5_000;

function getGitBranch(): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function getGitDirty(): boolean {
  try {
    const out = execSync('git status --porcelain', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function shortenPath(fullPath: string): string {
  const home = homedir();
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

function extractActiveFiles(messages: ChatMessage[], maxCount = 5): string[] {
  const seen = new Set<string>();
  const files: string[] = [];

  for (let i = messages.length - 1; i >= 0 && files.length < maxCount; i--) {
    const msg = messages[i]!;
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      const pathMatches = tc.arguments.match(
        /(?:["']?)(\/?\b(?:[\w.-]+\/)*[\w.-]+\.\w+)(?:["']?)/g,
      );
      if (!pathMatches) continue;
      for (const raw of pathMatches) {
        const clean = raw.replace(/['"]/g, '');
        const name = basename(clean);
        if (!seen.has(name)) {
          seen.add(name);
          files.push(name);
          if (files.length >= maxCount) break;
        }
      }
    }
  }

  return files;
}

export function useContextInfo(messages: ChatMessage[]): ContextInfo {
  const [cwd, setCwd] = useState(shortenPath(process.cwd()));
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitDirty, setGitDirty] = useState(false);

  useEffect(() => {
    function refresh() {
      setCwd(shortenPath(process.cwd()));
      setGitBranch(getGitBranch());
      setGitDirty(getGitDirty());
    }
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const activeFiles = useMemo(() => extractActiveFiles(messages), [messages]);

  return { cwd, gitBranch, gitDirty, activeFiles };
}
