# ClothOS

Agentic operating system — TypeScript monorepo using pnpm workspaces + Turborepo.

## Commands

- `turbo run build` — build all packages (dependency-ordered)
- `turbo run test` — run tests (Vitest)
- `turbo run check-types` — typecheck all packages
- `turbo run lint` — lint all packages
- `npx knip` — check for unused exports, dependencies, and dead code
- `pnpm add -F @clothos/<package> <dep>` — add a dependency to a specific package

## Architecture

- All shared types and interfaces live in `packages/core` (`@clothos/core`). Nothing imports back into core.
- Internal dependencies use the workspace protocol: `"@clothos/core": "workspace:*"`
- Every package exports via a single `src/index.ts` barrel.
- Build tool is `tsup`. TypeScript strict mode everywhere.

## Conventions

- Package manager is **pnpm** (not npm/yarn). Enforced via `corepack`.
- Package scope is `@clothos/`.
- Config files use JSON5 format with JSON Schema validation.
- Tests go in `tests/` directories within each package.
- The implementation plan is in `implementation-plan.md` at the repo root.
- Run `npx knip` after code changes to catch unused exports, dependencies, and dead code. Config is in `knip.json`.
