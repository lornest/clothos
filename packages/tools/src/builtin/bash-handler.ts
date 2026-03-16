import { execFile } from 'node:child_process';
import type { ToolHandler } from '@clothos/core';
import { classifyCommandRisk, sanitizeArguments } from './risk-classifier.js';

export interface BashHandlerOptions {
  defaultTimeout?: number;
  cwd?: string;
  yoloMode?: boolean;
  sandboxExecutor?: (
    command: string,
    timeout: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const DEFAULT_TIMEOUT = 30_000;

export function createBashHandler(options: BashHandlerOptions = {}): ToolHandler {
  const {
    defaultTimeout = DEFAULT_TIMEOUT,
    cwd,
    yoloMode = false,
    sandboxExecutor,
  } = options;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const command = args.command;
    if (typeof command !== 'string' || command.trim() === '') {
      return { error: 'command must be a non-empty string' };
    }

    // Risk classification
    const risk = classifyCommandRisk(command);
    if (risk.blocked) {
      return { error: `Command blocked: ${risk.reason}` };
    }

    // Argument sanitization
    const sanitizeIssue = sanitizeArguments(command);
    if (sanitizeIssue !== null) {
      return { error: `Command blocked: ${sanitizeIssue}` };
    }

    // Confirmation gate for red-level commands (no interactive confirmation, just block)
    if (!yoloMode && risk.level === 'red') {
      return {
        error: `Command requires confirmation (risk level: red). Run in yoloMode to bypass. Reason: ${risk.reason}`,
      };
    }

    const timeout =
      typeof args.timeout === 'number' && args.timeout > 0
        ? args.timeout
        : defaultTimeout;

    // Execute via sandbox or child_process
    if (sandboxExecutor) {
      return sandboxExecutor(command, timeout);
    }

    return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const child = execFile(
        '/bin/bash',
        ['-c', command],
        {
          timeout,
          cwd,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
        },
        (error, stdout, stderr) => {
          if (error && 'killed' in error && error.killed) {
            resolve({
              stdout: stdout ?? '',
              stderr: `Process timed out after ${timeout}ms`,
              exitCode: 124,
            });
            return;
          }

          const exitCode =
            error && 'code' in error && typeof error.code === 'number'
              ? error.code
              : error
                ? 1
                : 0;

          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode,
          });
        },
      );

      // Safety net: if the child process is still alive after timeout, kill it
      child.on('error', () => {
        resolve({
          stdout: '',
          stderr: 'Failed to start process',
          exitCode: 1,
        });
      });
    });
  };
}
