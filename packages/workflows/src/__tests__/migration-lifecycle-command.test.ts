import { describe, expect, it } from 'vitest';
import {
  createMigrationLifecycleCommandGate,
  validateMigrationLifecycleSignalCommand,
} from '../workflows/migration-lifecycle.js';

describe('migration lifecycle command gate', () => {
  it('accepts exact contiguous commands and treats an exact replay as a duplicate', () => {
    const gate = createMigrationLifecycleCommandGate();
    const first = { commandId: 'mlc_command_01', lifecycleSequence: 1 };
    const second = { commandId: 'mlc_command_02', lifecycleSequence: 2 };

    expect(gate.accept('pause', first)).toEqual({ status: 'accepted', command: first });
    expect(gate.accept('pause', first)).toEqual({ status: 'duplicate', command: first });
    expect(gate.accept('resume', second)).toEqual({ status: 'accepted', command: second });
    expect(gate.snapshot()).toEqual({
      lastSequence: 2,
      lastCommandId: second.commandId,
      lastAction: 'resume',
    });
  });

  it('fails closed on sequence substitution and gaps without advancing', () => {
    const gate = createMigrationLifecycleCommandGate();
    expect(
      gate.accept('pause', { commandId: 'mlc_command_01', lifecycleSequence: 1 }),
    ).toMatchObject({ status: 'accepted' });
    expect(
      gate.accept('resume', { commandId: 'mlc_substitute_01', lifecycleSequence: 1 }),
    ).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(
      gate.accept('cancel', { commandId: 'mlc_command_03', lifecycleSequence: 3 }),
    ).toMatchObject({ status: 'rejected', reason: 'out_of_order' });
    expect(
      gate.accept('resume', { commandId: 'mlc_command_02', lifecycleSequence: 2 }),
    ).toMatchObject({ status: 'accepted' });
    expect(gate.snapshot()).toMatchObject({ lastSequence: 2, lastAction: 'resume' });
  });

  it('supports an explicitly bound predecessor for a fresh command workflow', () => {
    const gate = createMigrationLifecycleCommandGate(2);
    expect(
      gate.accept('rollback', { commandId: 'mlc_rollback_03', lifecycleSequence: 3 }),
    ).toMatchObject({ status: 'accepted' });
    expect(gate.snapshot()).toMatchObject({ lastSequence: 3, lastAction: 'rollback' });
  });

  it.each([
    null,
    [],
    {},
    { commandId: 'short', lifecycleSequence: 1 },
    { commandId: 'mlc_command_01', lifecycleSequence: 0 },
    { commandId: 'mlc_command_01', lifecycleSequence: 1.5 },
    { commandId: 'mlc_command_01', lifecycleSequence: 1, extra: true },
    Object.create({ commandId: 'mlc_command_01', lifecycleSequence: 1 }),
  ])('rejects malformed or inherited command input %#', (value) => {
    expect(() => validateMigrationLifecycleSignalCommand(value)).toThrow(
      'MIGRATION_LIFECYCLE_COMMAND_INVALID',
    );
  });
});
