import type { AgentMessage } from '@clothos/core';
import type { LaneKey, MessageHandler } from './types.js';

interface QueueEntry {
  msg: AgentMessage;
  handler: MessageHandler;
}

export class LaneQueue {
  private readonly lanes = new Map<LaneKey, QueueEntry[]>();
  private readonly active = new Set<LaneKey>();

  async enqueue(
    laneKey: LaneKey,
    msg: AgentMessage,
    handler: MessageHandler,
  ): Promise<void> {
    if (!this.lanes.has(laneKey)) {
      this.lanes.set(laneKey, []);
    }

    const queue = this.lanes.get(laneKey)!;
    queue.push({ msg, handler });

    if (!this.active.has(laneKey)) {
      await this.drain(laneKey);
    }
  }

  private async drain(laneKey: LaneKey): Promise<void> {
    this.active.add(laneKey);
    const queue = this.lanes.get(laneKey)!;

    while (queue.length > 0) {
      const entry = queue.shift()!;
      try {
        await entry.handler(entry.msg);
      } catch {
        // Handler errors don't block subsequent messages
      }
    }

    this.active.delete(laneKey);
    this.lanes.delete(laneKey);
  }

  isActive(laneKey: LaneKey): boolean {
    return this.active.has(laneKey);
  }

  pendingCount(laneKey: LaneKey): number {
    return this.lanes.get(laneKey)?.length ?? 0;
  }
}
