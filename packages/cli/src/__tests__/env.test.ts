import { describe, it, expect } from 'vitest';
import { parseEnvFile, serializeEnvFile, updateEnvValue, isPlaceholderValue } from '../env.js';

describe('parseEnvFile', () => {
  it('parses basic key-value pairs', () => {
    const parsed = parseEnvFile('A=1\nB=2');
    expect(parsed.entries.get('A')).toBe('1');
    expect(parsed.entries.get('B')).toBe('2');
  });

  it('ignores comments and blank lines', () => {
    const parsed = parseEnvFile('# comment\n\nKEY=value\n');
    expect(parsed.entries.get('KEY')).toBe('value');
    expect(parsed.entries.size).toBe(1);
  });

  it('unwraps double and single quotes', () => {
    const parsed = parseEnvFile('DOUBLE="quoted value"\nSINGLE=\'quoted value\'');
    expect(parsed.entries.get('DOUBLE')).toBe('quoted value');
    expect(parsed.entries.get('SINGLE')).toBe('quoted value');
  });

  it('preserves inline comments only for unquoted values', () => {
    const parsed = parseEnvFile('UNQUOTED=value # comment\nQUOTED="value # not a comment"');
    expect(parsed.entries.get('UNQUOTED')).toBe('value');
    expect(parsed.entries.get('QUOTED')).toBe('value # not a comment');
  });

  it('serializes back to the original content', () => {
    const original = '# comment\nKEY=value\n\nQUOTED="v"\n';
    const parsed = parseEnvFile(original);
    expect(serializeEnvFile(parsed)).toBe(original);
  });

  it('updates an existing value and appends a new value', () => {
    const parsed = parseEnvFile('A=1');
    const updated = updateEnvValue(parsed, 'A', '2');
    expect(updated.entries.get('A')).toBe('2');
    expect(serializeEnvFile(updated)).toBe('A=2');

    const appended = updateEnvValue(parsed, 'B', '2');
    expect(appended.entries.get('B')).toBe('2');
    expect(serializeEnvFile(appended)).toBe('A=1\nB=2');
  });

  it('detects placeholder values', () => {
    expect(isPlaceholderValue('')).toBe(true);
    expect(isPlaceholderValue('<placeholder>')).toBe(true);
    expect(isPlaceholderValue('***************************************')).toBe(true);
    expect(isPlaceholderValue('real-value')).toBe(false);
  });
});
