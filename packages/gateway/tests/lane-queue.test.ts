import { describe, it, expect, vi } from 'vitest';
import { LaneQueue } from '../src/lane-queue.js';
import type { AgentMessage } from '@clothos/core';

function makeMsg(id: string): AgentMessage {
  return {
    id,
    specversion: '1.0',
    type: 'task.request',
    source: 'agent://test',
    target: 'agent://target',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {},
  };
}

describe('LaneQueue', () => {
  it('processes a single message immediately', async () => {
    const queue = new LaneQueue();
    const handler = vi.fn().mockResolvedValue(undefined);

    await queue.enqueue('a:b:c', makeMsg('1'), handler);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('processes messages in FIFO order within a lane', async () => {
    const queue = new LaneQueue();
    const order: string[] = [];

    // First message will start draining — it blocks while processing
    let resolveFirst!: () => void;
    const firstBlocks = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const handler1 = vi.fn(async (msg: AgentMessage) => {
      await firstBlocks;
      order.push(msg.id);
    });
    const handler2 = vi.fn(async (msg: AgentMessage) => {
      order.push(msg.id);
    });

    const p1 = queue.enqueue('lane', makeMsg('first'), handler1);
    // Queue second while first is blocked
    const p2 = queue.enqueue('lane', makeMsg('second'), handler2);

    // Release first
    resolveFirst();
    await p1;
    await p2;

    expect(order).toEqual(['first', 'second']);
  });

  it('continues processing after handler error', async () => {
    const queue = new LaneQueue();
    const results: string[] = [];

    const successHandler = vi.fn(async (msg: AgentMessage) => {
      results.push(msg.id);
    });

    let resolveFirst!: () => void;
    const block = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const blockingFail = vi.fn(async () => {
      await block;
      throw new Error('fail');
    });

    const p1 = queue.enqueue('lane', makeMsg('fail-msg'), blockingFail);
    const p2 = queue.enqueue('lane', makeMsg('ok-msg'), successHandler);

    resolveFirst();
    await p1;
    await p2;

    expect(results).toEqual(['ok-msg']);
  });

  it('handles independent lanes concurrently', async () => {
    const queue = new LaneQueue();
    const handler = vi.fn().mockResolvedValue(undefined);

    await Promise.all([
      queue.enqueue('lane-a', makeMsg('1'), handler),
      queue.enqueue('lane-b', makeMsg('2'), handler),
    ]);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('reports active and pending state', async () => {
    const queue = new LaneQueue();
    let resolveFirst!: () => void;
    const block = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const blockingHandler = vi.fn(() => block);
    const noopHandler = vi.fn().mockResolvedValue(undefined);

    const p1 = queue.enqueue('lane', makeMsg('1'), blockingHandler);
    // While first is processing, enqueue another
    queue.enqueue('lane', makeMsg('2'), noopHandler);

    expect(queue.isActive('lane')).toBe(true);
    expect(queue.pendingCount('lane')).toBe(1);

    resolveFirst();
    await p1;

    expect(queue.isActive('lane')).toBe(false);
    expect(queue.pendingCount('lane')).toBe(0);
  });
});
