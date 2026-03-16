import type { AgentMessage } from '@clothos/core';
import type { NatsClient } from './nats-client.js';

export interface ParsedTarget {
  scheme: string;
  path: string;
}

export function parseTarget(target: string): ParsedTarget {
  const match = target.match(/^(\w+):\/\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid target URI: ${target}`);
  }
  return { scheme: match[1]!, path: match[2]! };
}

export class MessageRouter {
  constructor(private readonly nats: NatsClient) {}

  async route(msg: AgentMessage): Promise<void> {
    const { scheme, path } = parseTarget(msg.target);

    switch (scheme) {
      case 'agent':
        await this.nats.publish(`agent.${path}.inbox`, msg);
        break;
      case 'topic':
        await this.nats.publish(`events.agent.${path}`, msg);
        break;
      default:
        throw new Error(`Unknown target scheme: ${scheme}`);
    }
  }
}
