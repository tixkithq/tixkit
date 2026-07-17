export type MigrationLifecycleAction = 'pause' | 'resume' | 'cancel' | 'rollback';

export type MigrationLifecycleSignalCommand = Readonly<{
  commandId: string;
  lifecycleSequence: number;
}>;

export type MigrationLifecycleCommandDecision =
  | Readonly<{ status: 'accepted'; command: MigrationLifecycleSignalCommand }>
  | Readonly<{ status: 'duplicate'; command: MigrationLifecycleSignalCommand }>
  | Readonly<{
      status: 'rejected';
      command: MigrationLifecycleSignalCommand;
      reason: 'conflict' | 'out_of_order';
    }>;

const commandIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

export function validateMigrationLifecycleSignalCommand(
  value: unknown,
): MigrationLifecycleSignalCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MIGRATION_LIFECYCLE_COMMAND_INVALID');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'commandId' || keys[1] !== 'lifecycleSequence') {
    throw new Error('MIGRATION_LIFECYCLE_COMMAND_INVALID');
  }
  const commandId = (value as { commandId?: unknown }).commandId;
  const lifecycleSequence = (value as { lifecycleSequence?: unknown }).lifecycleSequence;
  if (
    typeof commandId !== 'string' ||
    !commandIdPattern.test(commandId) ||
    !Number.isSafeInteger(lifecycleSequence) ||
    (lifecycleSequence as number) < 1
  ) {
    throw new Error('MIGRATION_LIFECYCLE_COMMAND_INVALID');
  }
  return Object.freeze({ commandId, lifecycleSequence: lifecycleSequence as number });
}

export function createMigrationLifecycleCommandGate(initialSequence = 0) {
  if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
    throw new Error('MIGRATION_LIFECYCLE_SEQUENCE_INVALID');
  }
  let lastSequence = initialSequence;
  let lastCommandId: string | undefined;
  let lastAction: MigrationLifecycleAction | undefined;
  let rejection:
    | Readonly<{
        commandId: string;
        lifecycleSequence: number;
        reason: 'conflict' | 'out_of_order';
      }>
    | undefined;
  const accepted = new Map<number, string>();

  return {
    accept(action: MigrationLifecycleAction, raw: unknown): MigrationLifecycleCommandDecision {
      const command = validateMigrationLifecycleSignalCommand(raw);
      const fingerprint = `${action}:${command.commandId}`;
      const prior = accepted.get(command.lifecycleSequence);
      if (prior) {
        if (prior === fingerprint) return Object.freeze({ status: 'duplicate', command });
        rejection = Object.freeze({ ...command, reason: 'conflict' as const });
        return Object.freeze({ status: 'rejected', command, reason: 'conflict' as const });
      }
      if (command.lifecycleSequence !== lastSequence + 1) {
        rejection = Object.freeze({ ...command, reason: 'out_of_order' as const });
        return Object.freeze({ status: 'rejected', command, reason: 'out_of_order' as const });
      }
      accepted.set(command.lifecycleSequence, fingerprint);
      lastSequence = command.lifecycleSequence;
      lastCommandId = command.commandId;
      lastAction = action;
      rejection = undefined;
      return Object.freeze({ status: 'accepted', command });
    },
    snapshot() {
      return Object.freeze({
        lastSequence,
        ...(lastCommandId ? { lastCommandId } : {}),
        ...(lastAction ? { lastAction } : {}),
        ...(rejection ? { rejection } : {}),
      });
    },
  };
}
