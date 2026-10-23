import { describe, it, expect } from 'vitest';

const { databaseCommand } = await import('../../../src/commands/database/index.js');

describe('database command group', () => {
  it('is invocable via the `db` alias', () => {
    expect(databaseCommand.name()).toBe('database');
    expect(databaseCommand.aliases()).toContain('db');
  });

  it('registers the public CA certificate download', () => {
    expect(databaseCommand.commands.map(command => command.name())).toContain('ca-certificate');
  });

  it('registers TLS lifecycle commands', () => {
    const tls = databaseCommand.commands.find(command => command.name() === 'tls');
    expect(tls?.commands.map(command => command.name())).toEqual(['status', 'ca-stage', 'ca-cancel', 'ca-activate', 'ca-rollback']);
  });
});
