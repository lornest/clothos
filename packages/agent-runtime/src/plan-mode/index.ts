// Controller
export { PlanModeController } from './plan-mode-controller.js';
export type { PlanModeTools } from './plan-mode-controller.js';

// Hooks
export { createPlanModeToolCallHook } from './plan-mode-hooks.js';

// Prompt handlers
export { createPlanModePromptHandler, createPlanContextHandler } from './plan-mode-prompt.js';

// Tool definitions + handler factories
export {
  enterPlanModeToolDefinition,
  createEnterPlanModeHandler,
  exitPlanModeToolDefinition,
  createExitPlanModeHandler,
  writePlanToolDefinition,
  createWritePlanHandler,
  editPlanToolDefinition,
  createEditPlanHandler,
} from './plan-mode-tools.js';

// Types
export type {
  PlanModeConfig,
  PlanModeState,
  PlanModeControllerOptions,
  ExitPlanModeResult,
} from './plan-mode-types.js';
