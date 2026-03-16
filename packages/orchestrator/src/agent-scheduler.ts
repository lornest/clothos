import type { AgentEvent, ScheduledTask } from '@clothos/core';
import { TaskPriority, generateId } from '@clothos/core';

/** Dispatch function signature: sends a message and yields agent events. */
export type DispatchFn = (message: string, sessionId?: string) => AsyncGenerator<AgentEvent>;

/** Options for the AgentScheduler. */
export interface AgentSchedulerOptions {
  maxConcurrent: number;
}

/**
 * Concurrency-limited priority queue controlling when dispatch() is called.
 *
 * - Below concurrency limit: execute immediately.
 * - At limit: insert into a sorted queue by priority (lower = higher), FIFO within same priority.
 * - On completion: drain the next queued item.
 */
export class AgentScheduler {
  private readonly maxConcurrent: number;
  private readonly agents = new Map<string, DispatchFn>();
  private readonly queue: QueuedItem[] = [];
  private running = 0;

  constructor(options: AgentSchedulerOptions) {
    this.maxConcurrent = options.maxConcurrent;
  }

  /** Register a dispatch function for an agent. */
  registerAgent(agentId: string, dispatchFn: DispatchFn): void {
    this.agents.set(agentId, dispatchFn);
  }

  /** Unregister an agent's dispatch function. */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Enqueue a task for execution. Returns the generated task ID immediately.
   *
   * If the scheduler is below its concurrency limit the task runs right away;
   * otherwise it is inserted into the priority queue and will be drained when
   * a running task completes.
   */
  enqueue(
    task: Omit<ScheduledTask, 'id' | 'enqueuedAt'>,
    onEvent?: (task: ScheduledTask, event: AgentEvent) => void,
    onDone?: (task: ScheduledTask) => void,
    onError?: (task: ScheduledTask, error: Error) => void,
  ): string {
    const fullTask: ScheduledTask = {
      ...task,
      id: generateId(),
      enqueuedAt: Date.now(),
    };

    const item: QueuedItem = { task: fullTask, onEvent, onDone, onError };

    if (this.running < this.maxConcurrent) {
      this.execute(item);
    } else {
      this.insertSorted(item);
    }

    return fullTask.id;
  }

  /** Number of tasks currently executing. */
  get activeCount(): number {
    return this.running;
  }

  /** Number of tasks waiting in the queue. */
  get queueDepth(): number {
    return this.queue.length;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /** Insert an item into the queue, maintaining priority + FIFO order. */
  private insertSorted(item: QueuedItem): void {
    // Find the first index where the existing item has a strictly greater
    // (i.e. lower-priority) value. For same priority, new items go after
    // existing ones (FIFO).
    let insertAt = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i]!.task.priority > item.task.priority) {
        insertAt = i;
        break;
      }
    }
    this.queue.splice(insertAt, 0, item);
  }

  /** Execute a queued item, consuming the async generator and calling callbacks. */
  private execute(item: QueuedItem): void {
    this.running++;

    const { task, onEvent, onDone, onError } = item;
    const dispatchFn = this.agents.get(task.agentId);

    if (!dispatchFn) {
      // Agent not registered — report error and drain
      const err = new Error(`Agent not registered: ${task.agentId}`);
      this.running--;
      onError?.(task, err);
      this.drain();
      return;
    }

    // Fire-and-forget the async work
    void this.consumeGenerator(dispatchFn, task, onEvent, onDone, onError);
  }

  /** Consume the async generator from a dispatch function, invoking callbacks. */
  private async consumeGenerator(
    dispatchFn: DispatchFn,
    task: ScheduledTask,
    onEvent?: (task: ScheduledTask, event: AgentEvent) => void,
    onDone?: (task: ScheduledTask) => void,
    onError?: (task: ScheduledTask, error: Error) => void,
  ): Promise<void> {
    try {
      const generator = dispatchFn(task.message, task.sessionId);
      for await (const event of generator) {
        onEvent?.(task, event);
      }
      onDone?.(task);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(task, error);
    } finally {
      this.running--;
      this.drain();
    }
  }

  /** Pop the next item from the queue and execute it, if capacity allows. */
  private drain(): void {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const next = this.queue.shift()!;
      this.execute(next);
    }
  }
}

/** Internal representation of a queued task with its callbacks. */
interface QueuedItem {
  task: ScheduledTask;
  onEvent?: (task: ScheduledTask, event: AgentEvent) => void;
  onDone?: (task: ScheduledTask) => void;
  onError?: (task: ScheduledTask, error: Error) => void;
}
