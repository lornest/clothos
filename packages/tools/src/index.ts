export const PACKAGE_NAME = '@clothos/tools';

export { ToolRegistry } from './registry.js';
export {
  ToolConflictError,
  ToolNotFoundError,
  ToolValidationError,
  SandboxError,
  McpConnectionError,
} from './errors.js';

export {
  classifyCommandRisk,
  sanitizeArguments,
  type RiskAssessment,
  bashToolDefinition,
  createBashHandler,
  type BashHandlerOptions,
  readFileToolDefinition,
  writeFileToolDefinition,
  editFileToolDefinition,
  createReadFileHandler,
  createWriteFileHandler,
  createEditFileHandler,
  type FileToolOptions,
  safePath,
  grepSearchToolDefinition,
  globFindToolDefinition,
  listDirectoryToolDefinition,
  createGrepSearchHandler,
  createGlobFindHandler,
  createListDirectoryHandler,
  gitStatusToolDefinition,
  gitDiffToolDefinition,
  gitCommitToolDefinition,
  createPrToolDefinition,
  createGitStatusHandler,
  createGitDiffHandler,
  createGitCommitHandler,
  createCreatePrHandler,
  type GitToolOptions,
  registerBuiltinTools,
  type RegisterBuiltinOptions,
} from './builtin/index.js';

export { PolicyEngine } from './policy-engine.js';
export { expandGroups, TOOL_GROUPS } from './tool-groups.js';

// Sandbox
export {
  SandboxManager,
  execFile,
  type ExecResult,
  dockerCreate,
  dockerStart,
  dockerExec,
  dockerRemove,
  dockerInfo,
  type DockerCreateOptions,
} from './sandbox/index.js';

// MCP client module
export {
  McpClientConnection,
  type McpToolInfo,
  McpClientManager,
  type McpToolSummary,
  useMcpToolDefinition,
  createUseMcpToolHandler,
  validateToolArgs,
  formatValidationErrors,
  type ValidationError,
  type ValidationResult,
  buildMcpCatalog,
  getPinnedToolDefinitions,
  formatMcpCatalog,
} from './mcp/index.js';

// Prompt integration
export { createMcpCatalogPromptHandler } from './prompt-integration.js';
