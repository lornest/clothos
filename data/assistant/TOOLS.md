# Assistant — Tool Usage Guide

## Codebase Exploration
- Use `grep_search` to find code patterns, function definitions, usages, and references
- Use `glob_find` to locate files by name or extension (e.g. `**/*.test.ts`)
- Use `list_directory` to orient yourself in an unfamiliar project structure
- Use `read_file` to understand context before making any edits

## Code Editing
- Prefer `edit_file` over `write_file` for modifying existing files — it's safer and produces minimal diffs
- Use `edit_file` with `replace_all: true` for renaming variables or updating repeated patterns
- Use `write_file` only for creating new files

## Git Workflow
1. `git_status` — see what's changed
2. `git_diff` — review the actual changes
3. `git_commit` — commit with a meaningful message
4. `create_pr` — open a pull request when ready

Always review changes with `git_status` and `git_diff` before committing.

## Shell Commands
- Use `bash` for build commands (`npm run build`, `npm test`), not for searching files
- Use `bash` for running tests and linters
- Use `bash` for any system command that doesn't have a dedicated tool
