import type { CommandHandler, Disposable } from '@clothos/core';

/** Registry for slash commands provided by plugins. */
export class CommandRegistry {
  private commands = new Map<string, CommandHandler>();

  /** Register a command handler. Returns a Disposable to unregister. */
  register(name: string, handler: CommandHandler): Disposable {
    this.commands.set(name, handler);
    return {
      dispose: () => {
        this.commands.delete(name);
      },
    };
  }

  /** Execute a registered command. Throws if unknown. */
  async execute(name: string, args: string): Promise<string | void> {
    const handler = this.commands.get(name);
    if (!handler) {
      throw new Error(`Unknown command: "${name}"`);
    }
    return handler(args);
  }

  /** Check whether a command is registered. */
  has(name: string): boolean {
    return this.commands.has(name);
  }

  /** Return all registered command names. */
  getAll(): string[] {
    return [...this.commands.keys()];
  }

  /** Remove all registered commands. */
  clear(): void {
    this.commands.clear();
  }
}
