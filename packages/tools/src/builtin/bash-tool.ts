import type { ToolDefinition } from '@clothos/core';

export const bashToolDefinition: ToolDefinition = {
  name: 'bash',
  description: 'Execute a bash command and return stdout, stderr, and exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds.',
      },
    },
    required: ['command'],
  },
  annotations: {
    readOnly: false,
    destructive: true,
    riskLevel: 'red',
  },
};
