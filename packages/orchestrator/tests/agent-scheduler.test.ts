import { describe, it, expect, vi } from 'vitest';
import { AgentScheduler } from '../src/agent-scheduler.js';
import type { DispatchFn } from '../src/agent-scheduler.js';
import type { AgentEvent, ScheduledTask } from '@clothos/core';
import { TaskPriority } from '@clothos/core';

// ── Helpers ─────────────────────────────────────────────────────────────

/** A simple mock dispatch that yields a single assistant_message event. */
async function* mockDispatch(msg: string): AsyncGenerator<AgentEvent> {
  yield { type: 'assistant_message', content: { text: `Response to: ${msg}` } };
}

/** A dispatch that throws an error. */
async function* errorDispatch(_msg: string): AsyncGenerator<AgentEvent> {
  throw new Error('dispatch failed');
}

/** A deferred dispatch that waits for manual resolution before yielding. */
function createDeferredDispatch(): {
  dispatch: DispatchFn;
  resolve: () => void;
  promise: Promise<void>;
} {
  let resolveOuter!: () => void;
  const promise = new Promise<void>((r) => {
    resolveOuter = r;
  });

  const dispatch: DispatchFn = async function* (msg: string) {
    await promise;
    yield { type: 'assistant_message', content: { text: `Deferred: ${msg}` } } as AgentEvent;
  };

  return { dispatch, resolve: resolveOuter, promise };
}

/** Flush all pending microtasks / promises. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('AgentScheduler', () => {
  // ── Registration ────────────────────────────────────────────────────

  describe('registerAgent / unregisterAgent', () => {
    it('registers an agent and dispatches to it', async () => {
      const scheduler = new AgentScheduler({ maxConcurrent: 2 });
      const onDone = vi.fn();

      scheduler.registerAgent('agent-1', mockDispatch);
      scheduler.enqueue(
        { agentId: 'agent-1', message: 'hello', priority: TaskPriority.USER },
        undefined,
        onDone,
      );

      await flushPromises();
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('unregisters an agent so subsequent dispatches fail', async () => {
      const scheduler = new AgentScheduler({ maxConcurrent: 2 });
      const onError = vi.fn();

      scheduler.registerAgent('agent-1', mockDispatch);
      scheduler.unregisterAgent('agent-1');

      scheduler.enqueue(
        { agentId: 'agent-1', message: 'hello', priority: TaskPriority.USER },
        undefined,
        undefined,
        onError,
      );

      await flushPromises();
      expect(onError).toHaveBeenCalledTimes(1);
      const [, err] = onError.mock.calls[0] as [ScheduledTask, Error];
      expect(err.message).toContain('Agent not registered');
    });
  });

  // ── Concurrency limiting ───────────────────────────────────────────

  describe('concurrency limiting', () => {
    it('executes tasks immediately when below the limit', async () => {
      const scheduler = new AgentScheduler({ maxConcurrent: 2 });
      scheduler.registerAgent('agent-1', mockDispatch);

      scheduler.enqueue({ agentId: 'agent-1', message: 'a', priority: TaskPriority.USER });
      scheduler.enqueue({ agentId: 'agent-1', message: 'b', priority: TaskPriority.USER });

      // Both should be active immediately
      expect(scheduler.activeCount).toBe(2);
      expect(scheduler.queueDepth).toBe(0);

      await flushPromises();
    });

    it('queues tasks when at the concurrency limit', async () => {
      const d1 = createDeferredDispatch();
      const d2 = createDeferredDispatch();

      const scheduler = new AgentScheduler({ maxConcurrent: 1 });
      scheduler.registerAgent('agent-1', d1.dispatch);
      scheduler.registerAgent('agent-2', d2.dispatch);

      scheduler.enqueue({ agentId: 'agent-1', message: 'first', priority: TaskPriority.USER });
      scheduler.enqueue({ agentId: 'agent-2', message: 'second', priority: TaskPriority.USER });

      expect(scheduler.activeCount).toBe(1);
      expect(scheduler.queueDepth).toBe(1);

      // Complete the first task
      d1.resolve();
      await flushPromises();

      // The second task should have been drained
      expect(scheduler.activeCount).toBe(1);
      expect(scheduler.queueDepth).toBe(0);

      d2.resolve();
      await flushPromises();

      expect(scheduler.activeCount).toBe(0);
      expect(scheduler.queueDepth).toBe(0);
    });
  });

  // ── Priority ordering ─────────────────────────────────────────────

  describe('priority ordering', () => {
    it('executes higher-priority (lower number) tasks before lower-priority ones', async () => {
      const executionOrder: string[] = [];
      const d1 = createDeferredDispatch(); // blocks the slot

      const trackedDispatch =
        (label: string): DispatchFn =>
        async function* (msg: string) {
          executionOrder.push(label);
          yield { type: 'assistant_message', content: { text: msg } };
        };

      const scheduler = new AgentScheduler({ maxConcurrent: 1 });
      scheduler.registerAgent('blocker', d1.dispatch);
      scheduler.registerAgent('bg', trackedDispatch('bg'));
      scheduler.registerAgent('user', trackedDispatch('user'));
      scheduler.registerAgent('deleg', trackedDispatch('deleg'));

      // Fill the single slot
      scheduler.enqueue({ agentId: 'blocker', message: 'block', priority: TaskPriority.USER });

      // Queue up tasks in reverse-priority order
      scheduler.enqueue({ agentId: 'bg', message: 'bg', priority: TaskPriority.BACKGROUND });
      scheduler.enqueue({ agentId: 'deleg', message: 'deleg', priority: TaskPriority.DELEGATION });
      scheduler.enqueue({ agentId: 'user', message: 'user', priority: TaskPriority.USER });

      expect(scheduler.queueDepth).toBe(3);

      // Release the blocker — tasks should drain in priority order
      d1.resolve();
      await flushPromises();

      expect(executionOrder).toEqual(['user', 'deleg', 'bg']);
    });
  });

  // ── FIFO within same priority ──────────────────────────────────────

  describe('FIFO within same priority', () => {
    it('tasks of equal priority are executed in FIFO order', async () => {
      const executionOrder: string[] = [];
      const d1 = createDeferredDispatch();

      const trackedDispatch =
        (label: string): DispatchFn =>
        async function* (msg: string) {
          executionOrder.push(label);
          yield { type: 'assistant_message', content: { text: msg } };
        };

      const scheduler = new AgentScheduler({ maxConcurrent: 1 });
      scheduler.registerAgent('blocker', d1.dispatch);
      scheduler.registerAgent('a', trackedDispatch('a'));
      scheduler.registerAgent('b', trackedDispatch('b'));
      scheduler.registerAgent('c', trackedDispatch('c'));

      scheduler.enqueue({ agentId: 'blocker', message: 'block', priority: TaskPriority.USER });
      scheduler.enqueue({ agentId: 'a', message: 'first', priority: TaskPriority.DELEGATION });
      scheduler.enqueue({ agentId: 'b', message: 'second', priority: TaskPriority.DELEGATION });
      scheduler.enqueue({ agentId: 'c', message: 'third', priority: TaskPriority.DELEGATION });

      d1.resolve();
      await flushPromises();

      expect(executionOrder).toEqual(['a', 'b', 'c']);
    });
  });

  // ── Drain on complete ──────────────────────────────────────────────

  describe('drain on complete', () => {
    it('completing a task automatically starts the next queued one', async () => {
      const d1 = createDeferredDispatch();
      const onDone2 = vi.fn();

      const scheduler = new AgentScheduler({ maxConcurrent: 1 });
      scheduler.registerAgent('agent-1', d1.dispatch);
      scheduler.registerAgent('agent-2', mockDispatch);

      scheduler.enqueue({ agentId: 'agent-1', message: 'first', priority: TaskPriority.USER });
      scheduler.enqueue(
        { agentId: 'agent-2', message: 'second', priority: TaskPriority.USER },
        undefined,
        onDone2,
      );

      expect(scheduler.activeCount).toBe(1);
      expect(scheduler.queueDepth).toBe(1);

      // First task hasn't completed, so second should not have started
      expect(onDone2).not.toHaveBeenCalled();

      // Release the first task
      d1.resolve();
      await flushPromises();

      // Second should now be done
      expect(onDone2).toHaveBeenCalledTimes(1);
      expect(scheduler.activeCount).toBe(0);
      expect(scheduler.queueDepth).toBe(0);
    });
  });

  // ── Callbacks ──────────────────────────────────────────────────────

  describe('callbacks', () => {
    it('onEvent is called for each yielded event', async () => {
      const onEvent = vi.fn();

      const multiEventDispatch: DispatchFn = async function* (msg: string) {
        yield { type: 'assistant_message', content: { text: `First: ${msg}` } };
        yield { type: 'assistant_message', content: { text: `Second: ${msg}` } };
      };

      const scheduler = new AgentScheduler({ maxConcurrent: 2 });
      scheduler.registerAgent('agent-1', multiEventDispatch);

      scheduler.enqueue(
        { agentId: 'agent-1', message: 'test', priority: TaskPriority.USER },
        onEvent,
      );

      await flushPromises();

      expect(onEvent).toHaveBeenCalledTimes(2);
      const [task1, event1] = onEvent.mock.calls[0] as [ScheduledTask, AgentEvent];
      expect(task1.agentId).toBe('agent-1');
      expect(event1.type).toBe('assistant_message');
    });

    it('onDone is called when dispatch completes successfully', async () => {
      const onDone = vi.fn();

      const scheduler = new AgentScheduler({ maxConcurrent: 2 });
      scheduler.registerAgent('agent-1', mockDispatch);

      scheduler.enqueue(
        { agentId: 'agent-1', message: 'hello', priority: TaskPriority.USER },
        undefined,
        onDone,
      );

      await flushPromises();

      expect(onDone).toHaveBeenCalledTimes(1);
      const [task] = onDone.mock.calls[0] as [ScheduledTask];
      expect(task.agentId).toBe('agent-1');
      expect(task.message).toBe('hello');
    });

    it('onError is called when dispatch throws', async () => {
      const onError = vi.fn();

      const scheduler = new AgentScheduler({ maxConcurrent: 2 });
      scheduler.registerAgent('agent-1', errorDispatch);

      scheduler.enqueue(
        { agentId: 'agent-1', message: 'boom', priority: TaskPriority.USER },
        undefined,
        undefined,
        onError,
      );

      await flushPromises();

      expect(onError).toHaveBeenCalledTimes(1);
      const [task, err] = onError.mock.calls[0] as [ScheduledTask, Error];
      expect(task.agentId).toBe('agent-1');
      expect(err.message).toBe('dispatch failed');
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe('error handling', () => {
    it('dispatching to an unregistered agent calls onError synchronously', async () => {
      const onError = vi.fn();
      const scheduler = new AgentScheduler({ maxConcurrent: 2 });

      scheduler.enqueue(
        { agentId: 'nonexistent', message: 'hello', priority: TaskPriority.USER },
        undefined,
        undefined,
        onError,
      );

      // The error for unregistered agent is synchronous — no need for await
      expect(onError).toHaveBeenCalledTimes(1);
      const [task, err] = onError.mock.calls[0] as [ScheduledTask, Error];
      expect(task.agentId).toBe('nonexistent');
      expect(err.message).toContain('Agent not registered');
    });

    it('error in dispatch still drains the next queued task', async () => {
      const d1 = createDeferredDispatch();
      const onDone = vi.fn();

      const failingDispatch: DispatchFn = async function* () {
        throw new Error('kaboom');
      };

      const scheduler = new AgentScheduler({ maxConcurrent: 1 });
      scheduler.registerAgent('fail-agent', failingDispatch);
      scheduler.registerAgent('ok-agent', mockDispatch);

      // Fill the slot with a blocker, queue the failing and ok tasks
      scheduler.enqueue({ agentId: 'fail-agent', message: 'fail', priority: TaskPriority.USER });
      scheduler.enqueue(
        { agentId: 'ok-agent', message: 'ok', priority: TaskPriority.USER },
        undefined,
        onDone,
      );

      await flushPromises();

      // The failing task errored out, but the ok task should have drained and completed
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(scheduler.activeCount).toBe(0);
      expect(scheduler.queueDepth).toBe(0);
    });
  });

  // ── Task ID generation ─────────────────────────────────────────────

  describe('task ID', () => {
    it('returns a unique task ID from enqueue', () => {
      const scheduler = new AgentScheduler({ maxConcurrent: 10 });
      scheduler.registerAgent('agent-1', mockDispatch);

      const id1 = scheduler.enqueue({
        agentId: 'agent-1',
        message: 'a',
        priority: TaskPriority.USER,
      });
      const id2 = scheduler.enqueue({
        agentId: 'agent-1',
        message: 'b',
        priority: TaskPriority.USER,
      });

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it('provides the generated task ID and enqueuedAt to callbacks', async () => {
      const onDone = vi.fn();
      const scheduler = new AgentScheduler({ maxConcurrent: 2 });
      scheduler.registerAgent('agent-1', mockDispatch);

      const taskId = scheduler.enqueue(
        { agentId: 'agent-1', message: 'test', priority: TaskPriority.USER },
        undefined,
        onDone,
      );

      await flushPromises();

      const [task] = onDone.mock.calls[0] as [ScheduledTask];
      expect(task.id).toBe(taskId);
      expect(task.enqueuedAt).toBeGreaterThan(0);
    });
  });
});
