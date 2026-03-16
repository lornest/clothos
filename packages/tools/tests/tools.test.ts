import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('tools', () => {
  it('exports package name', () => {
    expect(PACKAGE_NAME).toBe('@clothos/tools');
  });
});
