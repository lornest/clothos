import type { RiskLevel } from '@clothos/core';

export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
  blocked: boolean;
}

const CRITICAL_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\/\s*$/,
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\/\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bmkfs\b/,
  /\binit\s+0\b/,
];

const RED_COMMANDS = new Set([
  'rm',
  'curl',
  'wget',
  'docker',
  'sudo',
  'chmod',
  'chown',
]);

/** Multi-word red commands (matched as prefixes). */
const RED_PREFIXES = ['pip install', 'npm publish'];

const YELLOW_COMMANDS = new Set([
  'git',
  'grep',
  'find',
  'npm',
  'node',
  'python',
  'make',
  'cargo',
  'go',
]);

const GREEN_COMMANDS = new Set([
  'ls',
  'pwd',
  'cat',
  'echo',
  'head',
  'tail',
  'wc',
  'date',
  'whoami',
  'env',
  'which',
  'true',
  'false',
  'test',
  'printf',
]);

/**
 * Extract the base command from a shell segment.
 * Strips leading env-var assignments (`FOO=bar`) and path prefixes (`/usr/bin/`).
 */
function extractBaseCommand(segment: string): string {
  let trimmed = segment.trim();

  // Strip leading env-var assignments (e.g. `VAR=value cmd`)
  while (/^\w+=\S*\s/.test(trimmed)) {
    trimmed = trimmed.replace(/^\w+=\S*\s+/, '');
  }

  const firstWord = trimmed.split(/\s+/)[0] ?? '';

  // Strip path prefix: /usr/bin/rm -> rm
  const idx = firstWord.lastIndexOf('/');
  return idx === -1 ? firstWord : firstWord.slice(idx + 1);
}

function classifySegment(segment: string): { level: RiskLevel; reason: string } {
  const trimmed = segment.trim();

  // Check critical patterns against the full segment
  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { level: 'critical', reason: `Critical command detected: ${trimmed}` };
    }
  }

  const baseCmd = extractBaseCommand(trimmed);

  // Check red prefixes (multi-word commands like "pip install")
  for (const prefix of RED_PREFIXES) {
    if (trimmed.startsWith(prefix) || trimmed.includes(` ${prefix}`)) {
      return { level: 'red', reason: `Potentially dangerous command: ${prefix}` };
    }
  }

  if (RED_COMMANDS.has(baseCmd)) {
    return { level: 'red', reason: `Potentially dangerous command: ${baseCmd}` };
  }

  if (YELLOW_COMMANDS.has(baseCmd)) {
    return { level: 'yellow', reason: `Logged command: ${baseCmd}` };
  }

  if (GREEN_COMMANDS.has(baseCmd)) {
    return { level: 'green', reason: `Safe command: ${baseCmd}` };
  }

  // Unknown commands default to yellow
  return { level: 'yellow', reason: `Unknown command: ${baseCmd}` };
}

const RISK_ORDER: Record<RiskLevel, number> = {
  green: 0,
  yellow: 1,
  red: 2,
  critical: 3,
};

/**
 * Classify the risk level of a shell command (or chain of commands).
 * Chains separated by `&&`, `||`, `;`, or `|` are split and the highest risk wins.
 */
export function classifyCommandRisk(command: string): RiskAssessment {
  const segments = command.split(/&&|\|\||;|\|/);
  let highest: { level: RiskLevel; reason: string } = {
    level: 'green',
    reason: 'Safe command',
  };

  for (const segment of segments) {
    if (!segment.trim()) continue;
    const result = classifySegment(segment);
    if (RISK_ORDER[result.level] > RISK_ORDER[highest.level]) {
      highest = result;
    }
  }

  return {
    level: highest.level,
    reason: highest.reason,
    blocked: highest.level === 'critical',
  };
}

/**
 * Check a command for argument-level injection risks.
 * Returns a blocking reason string if unsafe, or null if safe.
 */
export function sanitizeArguments(command: string): string | null {
  // Block shell injection via $() and backticks
  if (/\$\(/.test(command)) {
    return 'Command substitution via $() is not allowed';
  }
  if (/`/.test(command)) {
    return 'Command substitution via backticks is not allowed';
  }

  // Block env var injection at start of command
  if (/^LD_PRELOAD=/.test(command.trim())) {
    return 'LD_PRELOAD injection is not allowed';
  }
  if (/^LD_LIBRARY_PATH=/.test(command.trim())) {
    return 'LD_LIBRARY_PATH injection is not allowed';
  }
  if (/^PATH=/.test(command.trim())) {
    return 'PATH injection is not allowed';
  }

  // Block dangerous flags on find/git commands
  const baseCmd = extractBaseCommand(command);
  if (baseCmd === 'find' || baseCmd === 'git') {
    if (/--exec\b/.test(command) || /\s-exec\b/.test(command)) {
      return `-exec flag is not allowed on ${baseCmd} commands`;
    }
  }

  // Block git-specific dangerous flags
  if (baseCmd === 'git') {
    if (/--upload-pack\b/.test(command)) {
      return '--upload-pack flag is not allowed on git commands';
    }
    if (/--post-checkout\b/.test(command)) {
      return '--post-checkout flag is not allowed on git commands';
    }
  }

  return null;
}
