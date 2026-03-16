import type { Disposable, HookHandler, LifecycleEvent } from '@clothos/core';
import type { HookEntry } from './types.js';
import { HookBlockError } from './errors.js';

export class HookRegistry {
  private hooks = new Map<LifecycleEvent, HookEntry[]>();

  register(
    event: LifecycleEvent,
    handler: HookHandler,
    priority = 100,
  ): Disposable {
    const entry: HookEntry = { event, priority, handler, disposable: true };

    let entries = this.hooks.get(event);
    if (!entries) {
      entries = [];
      this.hooks.set(event, entries);
    }
    entries.push(entry);

    return {
      dispose: () => {
        const list = this.hooks.get(event);
        if (list) {
          const idx = list.indexOf(entry);
          if (idx !== -1) list.splice(idx, 1);
        }
      },
    };
  }

  async fire(event: LifecycleEvent, context: unknown): Promise<unknown> {
    const entries = this.hooks.get(event);
    if (!entries || entries.length === 0) return context;

    const sorted = [...entries].sort((a, b) => a.priority - b.priority);
    let result: unknown = context;

    for (const entry of sorted) {
      try {
        result = await entry.handler(result);
      } catch (err) {
        if (err instanceof HookBlockError) throw err;
        throw err;
      }
    }

    return result;
  }

  clear(event: LifecycleEvent): void {
    this.hooks.delete(event);
  }

  clearAll(): void {
    this.hooks.clear();
  }

  handlerCount(event: LifecycleEvent): number {
    return this.hooks.get(event)?.length ?? 0;
  }
}
