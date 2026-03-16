import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DockerConfig } from '@clothos/core';

// Mock the docker-cli module before importing SandboxManager
vi.mock('../src/sandbox/docker-cli.js', () => ({
  dockerCreate: vi.fn(),
  dockerStart: vi.fn(),
  dockerExec: vi.fn(),
  dockerRemove: vi.fn(),
  dockerInfo: vi.fn(),
}));

// Import after mocking
import { SandboxManager } from '../src/sandbox/sandbox-manager.js';
import {
  dockerCreate,
  dockerStart,
  dockerExec,
  dockerRemove,
  dockerInfo,
} from '../src/sandbox/docker-cli.js';

const mockDockerCreate = vi.mocked(dockerCreate);
const mockDockerStart = vi.mocked(dockerStart);
const mockDockerExec = vi.mocked(dockerExec);
const mockDockerRemove = vi.mocked(dockerRemove);
const mockDockerInfo = vi.mocked(dockerInfo);

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

describe('SandboxManager', () => {
  let manager: SandboxManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SandboxManager(testConfig);
  });

  // ── getOrCreate ─────────────────────────────────────────────────────

  describe('getOrCreate', () => {
    it('creates a container and starts it', async () => {
      mockDockerCreate.mockResolvedValue('container-abc123');
      mockDockerStart.mockResolvedValue(undefined);

      const containerId = await manager.getOrCreate('session-1', '/workspace');

      expect(containerId).toBe('container-abc123');
      expect(mockDockerCreate).toHaveBeenCalledWith({
        name: 'agentic-sandbox-session-1',
        config: testConfig,
        workspaceDir: '/workspace',
      });
      expect(mockDockerStart).toHaveBeenCalledWith('container-abc123');
    });

    it('reuses existing container for the same scope key', async () => {
      mockDockerCreate.mockResolvedValue('container-abc123');
      mockDockerStart.mockResolvedValue(undefined);

      const first = await manager.getOrCreate('session-1', '/workspace');
      const second = await manager.getOrCreate('session-1', '/workspace');

      expect(first).toBe(second);
      expect(mockDockerCreate).toHaveBeenCalledTimes(1);
      expect(mockDockerStart).toHaveBeenCalledTimes(1);
    });
  });

  // ── exec ────────────────────────────────────────────────────────────

  describe('exec', () => {
    it('delegates to dockerExec', async () => {
      mockDockerExec.mockResolvedValue({
        stdout: 'output',
        stderr: '',
        exitCode: 0,
      });

      const result = await manager.exec('container-abc', 'ls -la', 5000);

      expect(mockDockerExec).toHaveBeenCalledWith('container-abc', 'ls -la', 5000);
      expect(result).toEqual({ stdout: 'output', stderr: '', exitCode: 0 });
    });

    it('uses config timeout when no timeout override is provided', async () => {
      mockDockerExec.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await manager.exec('container-abc', 'pwd');

      expect(mockDockerExec).toHaveBeenCalledWith('container-abc', 'pwd', 30_000);
    });
  });

  // ── destroy ─────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('removes a container by scope key', async () => {
      mockDockerCreate.mockResolvedValue('container-abc123');
      mockDockerStart.mockResolvedValue(undefined);
      mockDockerRemove.mockResolvedValue(undefined);

      await manager.getOrCreate('session-1', '/workspace');
      await manager.destroy('session-1');

      expect(mockDockerRemove).toHaveBeenCalledWith('container-abc123');
    });

    it('is a no-op for unknown scope key', async () => {
      await manager.destroy('nonexistent');
      expect(mockDockerRemove).not.toHaveBeenCalled();
    });
  });

  // ── destroyAll ──────────────────────────────────────────────────────

  describe('destroyAll', () => {
    it('removes all containers', async () => {
      mockDockerCreate.mockResolvedValueOnce('c1').mockResolvedValueOnce('c2');
      mockDockerStart.mockResolvedValue(undefined);
      mockDockerRemove.mockResolvedValue(undefined);

      await manager.getOrCreate('session-1', '/workspace');
      await manager.getOrCreate('session-2', '/workspace');
      await manager.destroyAll();

      expect(mockDockerRemove).toHaveBeenCalledWith('c1');
      expect(mockDockerRemove).toHaveBeenCalledWith('c2');
    });
  });

  // ── isDockerAvailable ──────────────────────────────────────────────

  describe('isDockerAvailable', () => {
    it('delegates to dockerInfo', async () => {
      mockDockerInfo.mockResolvedValue(true);

      const available = await manager.isDockerAvailable();

      expect(available).toBe(true);
      expect(mockDockerInfo).toHaveBeenCalled();
    });

    it('returns false when docker is not available', async () => {
      mockDockerInfo.mockResolvedValue(false);

      const available = await manager.isDockerAvailable();

      expect(available).toBe(false);
    });
  });
});
