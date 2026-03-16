import type { DockerConfig } from '@clothos/core';
import { execFile, type ExecResult } from './exec-util.js';

export interface DockerCreateOptions {
  name: string;
  config: DockerConfig;
  workspaceDir: string;
}

/**
 * Create a container with the security flags defined by {@link DockerConfig}.
 * Returns the container ID (trimmed stdout).
 */
export async function dockerCreate(options: DockerCreateOptions): Promise<string> {
  const { name, config, workspaceDir } = options;

  const args: string[] = [
    'create',
    '--name',
    name,
    '--memory',
    config.memoryLimit,
    '--cpus',
    config.cpuLimit,
    '--pids-limit',
    String(config.pidsLimit),
    '--network',
    config.networkMode,
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,size=${config.tmpfsSize}`,
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--user',
    '1000:1000',
    '-v',
    `${workspaceDir}:/workspace`,
  ];

  if (config.readOnlyRoot) {
    args.push('--read-only');
  }

  args.push(config.image);

  const result = await execFile('docker', args);
  if (result.exitCode !== 0) {
    throw new Error(`docker create failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Start a previously-created container. */
export async function dockerStart(containerId: string): Promise<void> {
  const result = await execFile('docker', ['start', containerId]);
  if (result.exitCode !== 0) {
    throw new Error(`docker start failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

/**
 * Execute a command inside a running container.
 *
 * The command is passed to `/bin/bash -c` so shell features are available.
 */
export async function dockerExec(
  containerId: string,
  command: string,
  timeout: number,
): Promise<ExecResult> {
  return execFile('docker', ['exec', containerId, '/bin/bash', '-c', command], {
    timeout,
  });
}

/** Force-remove a container (running or stopped). */
export async function dockerRemove(containerId: string): Promise<void> {
  await execFile('docker', ['rm', '-f', containerId]);
}

/** Returns `true` if the Docker daemon is reachable. */
export async function dockerInfo(): Promise<boolean> {
  const result = await execFile('docker', ['info'], { timeout: 5_000 });
  return result.exitCode === 0;
}
