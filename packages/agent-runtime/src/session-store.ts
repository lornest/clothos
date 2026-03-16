import type { Message } from '@clothos/core';
import { generateId, now } from '@clothos/core';
import type { FileSystem, SessionEntry, SessionHeader, SessionLine } from './types.js';
import { SessionCorruptError } from './errors.js';

export class SessionStore {
  constructor(
    private basePath: string,
    private fs: FileSystem,
  ) {}

  async createSession(agentId: string, channel?: string): Promise<string> {
    const sessionId = generateId();
    const dir = `${this.basePath}/${agentId}`;
    await this.fs.mkdir(dir, { recursive: true });

    const header: SessionHeader = {
      type: 'session_header',
      sessionId,
      agentId,
      channel,
      createdAt: now(),
    };
    await this.fs.writeFile(
      `${dir}/${sessionId}.jsonl`,
      JSON.stringify(header) + '\n',
    );
    return sessionId;
  }

  async appendEntry(
    agentId: string,
    sessionId: string,
    message: Message,
    parentId?: string,
  ): Promise<string> {
    const entryId = generateId();
    const entry: SessionEntry = {
      type: 'session_entry',
      id: entryId,
      parentId,
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      timestamp: now(),
    };
    await this.fs.appendFile(
      `${this.basePath}/${agentId}/${sessionId}.jsonl`,
      JSON.stringify(entry) + '\n',
    );
    return entryId;
  }

  async getHistory(agentId: string, sessionId: string): Promise<Message[]> {
    const lines = await this.readLines(agentId, sessionId);
    return lines
      .filter((l): l is SessionEntry => l.type === 'session_entry')
      .map((e) => ({
        role: e.role,
        content: e.content,
        toolCallId: e.toolCallId,
        toolCalls: e.toolCalls,
      }));
  }

  async getHeader(agentId: string, sessionId: string): Promise<SessionHeader> {
    const lines = await this.readLines(agentId, sessionId);
    const header = lines.find((l): l is SessionHeader => l.type === 'session_header');
    if (!header) {
      throw new SessionCorruptError(sessionId);
    }
    return header;
  }

  async forkSession(
    agentId: string,
    sourceSessionId: string,
    upToEntryId?: string,
  ): Promise<string> {
    const lines = await this.readLines(agentId, sourceSessionId);
    const newSessionId = generateId();
    const dir = `${this.basePath}/${agentId}`;

    const header: SessionHeader = {
      type: 'session_header',
      sessionId: newSessionId,
      agentId,
      createdAt: now(),
    };

    let content = JSON.stringify(header) + '\n';

    for (const line of lines) {
      if (line.type === 'session_entry') {
        content += JSON.stringify(line) + '\n';
        if (upToEntryId && line.id === upToEntryId) break;
      }
    }

    await this.fs.writeFile(`${dir}/${newSessionId}.jsonl`, content);
    return newSessionId;
  }

  async listSessions(agentId: string): Promise<string[]> {
    const dir = `${this.basePath}/${agentId}`;
    const dirExists = await this.fs.exists(dir);
    if (!dirExists) return [];

    const files = await this.fs.readdir(dir);
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''));
  }

  private async readLines(agentId: string, sessionId: string): Promise<SessionLine[]> {
    const path = `${this.basePath}/${agentId}/${sessionId}.jsonl`;
    let raw: string;
    try {
      raw = await this.fs.readFile(path);
    } catch (err) {
      throw new SessionCorruptError(sessionId, err);
    }

    const lines: SessionLine[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as SessionLine);
      } catch (err) {
        throw new SessionCorruptError(sessionId, err);
      }
    }
    return lines;
  }
}
