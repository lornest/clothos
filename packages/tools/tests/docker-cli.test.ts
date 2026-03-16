import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DockerConfig } from '@clothos/core';

// Mock exec-util before importing docker-cli
vi.mock('../src/sandbox/exec-util.js', () => ({
  execFile: vi.fn(),
}));

import {
  dockerCreate,
  dockerExec,
  dockerRemove,
  dockerInfo,
} from '../src/sandbox/docker-cli.js';
import { execFile } from '../src/sandbox/exec-util.js';

const mockExecFile = vi.mocked(execFile);

const testConfig: DockerConfig = {
  image: 'clothos-sandbox:latest',
  memoryLimit: '512m',
  cpuLimit: '1.0',
  pidsLimit: 100,
  networkMode: 'none',
  readOnlyRoot: true,
  tmpfsSize: '64m',
  timeout: 30_000,
};

describe('docker-cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── dockerCreate ───────────────────────────────────────────────────

  describe('dockerCreate', () => {
    it('builds the correct docker create command with security flags', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'container-id-abc\n',
        stderr: '',
        exitCode: 0,
      });

      const result = await dockerCreate({
        name: 'test-sandbox',
        config: testConfig,
        workspaceDir: '/home/user/project',
      });

      expect(result).toBe('container-id-abc');

      // Verify the args passed to execFile
      const [cmd, args] = mockExecFile.mock.calls[0]!;
      expect(cmd).toBe('docker');
      expect(args).toContain('create');
      expect(args).toContain('--name');
      expect(args).toContain('test-sandbox');
      expect(args).toContain('--memory');
      expect(args).toContain('512m');
      expect(args).toContain('--cpus');
      expect(args).toContain('1.0');
      expect(args).toContain('--pids-limit');
      expect(args).toContain('100');
      expect(args).toContain('--network');
      expect(args).toContain('none');
      expect(args).toContain('--security-opt');
      expect(args).toContain('no-new-privileges');
      expect(args).toContain('--cap-drop');
      expect(args).toContain('ALL');
      expect(args).toContain('--user');
      expect(args).toContain('1000:1000');
      expect(args).toContain('--read-only');
      expect(args).toContain('-v');
      expect(args).toContain('/home/user/project:/workspace');
      expect(args).toContain('clothos-sandbox:latest');
    });

    it('omits --read-only when readOnlyRoot is false', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'cid\n',
        stderr: '',
        exitCode: 0,
      });

      const config: DockerConfig = { ...testConfig, readOnlyRoot: false };
      await dockerCreate({
        name: 'test',
        config,
        workspaceDir: '/workspace',
      });

      const [, args] = mockExecFile.mock.calls[0]!;
      expect(args).not.toContain('--read-only');
    });

    it('throws when docker create fails', async () => {
      mockExecFile.mockResolvedValue({
        stdout: '',
        stderr: 'error: no space',
        exitCode: 1,
      });

      await expect(
        dockerCreate({ name: 'test', config: testConfig, workspaceDir: '/ws' }),
      ).rejects.toThrow('docker create failed');
    });
  });

  // ── dockerExec ─────────────────────────────────────────────────────

  describe('dockerExec', () => {
    it('runs docker exec with proper args', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'hello',
        stderr: '',
        exitCode: 0,
      });

      const result = await dockerExec('container-123', 'echo hello', 5000);

      expect(result).toEqual({ stdout: 'hello', stderr: '', exitCode: 0 });

      const [cmd, args, opts] = mockExecFile.mock.calls[0]!;
      expect(cmd).toBe('docker');
      expect(args).toEqual(['exec', 'container-123', '/bin/bash', '-c', 'echo hello']);
      expect(opts).toEqual({ timeout: 5000 });
    });
  });

  // ── dockerRemove ───────────────────────────────────────────────────

  describe('dockerRemove', () => {
    it('runs docker rm -f', async () => {
      mockExecFile.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await dockerRemove('container-123');

      const [cmd, args] = mockExecFile.mock.calls[0]!;
      expect(cmd).toBe('docker');
      expect(args).toEqual(['rm', '-f', 'container-123']);
    });
  });

  // ── dockerInfo ─────────────────────────────────────────────────────

  describe('dockerInfo', () => {
    it('returns true when docker is available', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'Docker info...',
        stderr: '',
        exitCode: 0,
      });

      const result = await dockerInfo();
      expect(result).toBe(true);
    });

    it('returns false when docker is not available', async () => {
      mockExecFile.mockResolvedValue({
        stdout: '',
        stderr: 'Cannot connect to Docker',
        exitCode: 1,
      });

      const result = await dockerInfo();
      expect(result).toBe(false);
    });
  });
});
