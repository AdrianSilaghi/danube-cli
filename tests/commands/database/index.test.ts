import { describe, it, expect } from 'vitest';

const { databaseCommand } = await import('../../../src/commands/database/index.js');

describe('database command group', () => {
  it('is invocable via the `db` alias', () => {
    expect(databaseCommand.name()).toBe('database');
    expect(databaseCommand.aliases()).toContain('db');
  });
});
