import { describe, it, expect } from 'vitest';
import type { AgentMessage, BindingOverrides } from '@clothos/core';

// Test the override serialization/deserialization pattern
describe('binding overrides', () => {
  it('serializes overrides into metadata', () => {
    const overrides: BindingOverrides = { tools: { deny: ['bash'] } };
    const metadata: Record<string, string> = {};
    metadata['x-binding-overrides'] = JSON.stringify(overrides);

    const parsed = JSON.parse(metadata['x-binding-overrides']!) as BindingOverrides;
    expect(parsed.tools?.deny).toEqual(['bash']);
  });

  it('round-trips tool overrides correctly', () => {
    const overrides: BindingOverrides = {
      tools: { allow: ['read_file', 'memory_search'], deny: ['bash', 'write_file'] },
      model: 'gpt-4',
      workspace: '/custom/workspace',
    };
    const serialized = JSON.stringify(overrides);
    const deserialized = JSON.parse(serialized) as BindingOverrides;

    expect(deserialized.tools?.allow).toEqual(['read_file', 'memory_search']);
    expect(deserialized.tools?.deny).toEqual(['bash', 'write_file']);
    expect(deserialized.model).toBe('gpt-4');
    expect(deserialized.workspace).toBe('/custom/workspace');
  });

  it('handles missing overrides gracefully', () => {
    const metadata: Record<string, string> = {};
    const overridesJson = metadata['x-binding-overrides'];
    expect(overridesJson).toBeUndefined();
  });

  it('handles malformed JSON gracefully', () => {
    const metadata = { 'x-binding-overrides': 'not-json' };
    let parsed: BindingOverrides | undefined;
    try {
      parsed = JSON.parse(metadata['x-binding-overrides']) as BindingOverrides;
    } catch {
      parsed = undefined;
    }
    expect(parsed).toBeUndefined();
  });

  it('preserves existing metadata when adding overrides', () => {
    const agentMsg: AgentMessage = {
      id: 'msg-1',
      specversion: '1.0',
      type: 'task.request',
      source: 'channel://webchat/user1',
      target: 'agent://assistant',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: { text: 'hello' },
      metadata: {
        channelType: 'webchat',
        senderId: 'user1',
      },
    };

    const overrides: BindingOverrides = { tools: { deny: ['bash'] } };
    agentMsg.metadata = {
      ...agentMsg.metadata,
      'x-binding-overrides': JSON.stringify(overrides),
    };

    // Original metadata preserved
    expect(agentMsg.metadata['channelType']).toBe('webchat');
    expect(agentMsg.metadata['senderId']).toBe('user1');
    // Overrides added
    const parsed = JSON.parse(agentMsg.metadata['x-binding-overrides']!) as BindingOverrides;
    expect(parsed.tools?.deny).toEqual(['bash']);
  });
});
