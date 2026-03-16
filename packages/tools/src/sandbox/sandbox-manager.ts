import type { DockerConfig } from '@clothos/core';
import { SandboxError } from '../errors.js';
import { dockerCreate, dockerExec, dockerInfo, dockerRemove, dockerStart } from './docker-cli.js';

/**
 * Manages Docker sandbox containers keyed by a scope identifier
 * (e.g. session ID, agent ID, or a shared key).
 */
export class SandboxManager {
  private containers = new Map<string, string>(); // scopeKey -> containerId

  constructor(private readonly config: DockerConfig) {}

  /**
   * Return the existing container for {@link scopeKey}, or create and start a
   * new one bound to {@link workspaceDir}.
   */
  async getOrCreate(scopeKey: string, workspaceDir: string): Promise<string> {
    const existing = this.containers.get(scopeKey);
    if (existing) {
      return existing;
    }

    const name = `agentic-sandbox-${scopeKey}`;

    try {
      const containerId = await dockerCreate({
        name,
        config: this.config,
        workspaceDir,
      });

      await dockerStart(containerId);
      this.containers.set(scopeKey, containerId);
      return containerId;
    } catch (error) {
      throw new SandboxError(
        `Failed to create sandbox for scope "${scopeKey}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Execute a command in a sandbox container.
   *
   * @param containerId - The container to execute in.
   * @param command     - Shell command string.
   * @param timeout     - Override the default timeout from config.
   */
  async exec(
    containerId: string,
    command: string,
    timeout?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const effectiveTimeout = timeout ?? this.config.timeout;
    try {
      return await dockerExec(containerId, command, effectiveTimeout);
    } catch (error) {
      throw new SandboxError(
        `Sandbox exec failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Destroy a specific sandbox by scope key. */
  async destroy(scopeKey: string): Promise<void> {
    const containerId = this.containers.get(scopeKey);
    if (!containerId) {
      return;
    }

    try {
      await dockerRemove(containerId);
    } catch (error) {
      throw new SandboxError(
        `Failed to destroy sandbox "${scopeKey}": ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.containers.delete(scopeKey);
    }
  }

  /** Destroy all managed sandbox containers. */
  async destroyAll(): Promise<void> {
    const entries = [...this.containers.entries()];
    const errors: string[] = [];

    await Promise.all(
      entries.map(async ([scopeKey, containerId]) => {
        try {
          await dockerRemove(containerId);
        } catch (error) {
          errors.push(
            `${scopeKey}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          this.containers.delete(scopeKey);
        }
      }),
    );

    if (errors.length > 0) {
      throw new SandboxError(`Failed to destroy some sandboxes: ${errors.join('; ')}`);
    }
  }

  /** Check if Docker is available on the host. */
  async isDockerAvailable(): Promise<boolean> {
    return dockerInfo();
  }
}
