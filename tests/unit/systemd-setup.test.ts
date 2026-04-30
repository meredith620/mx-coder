import { describe, test, expect } from 'vitest';
import { parseCLIArgs } from '../../src/cli-parser.js';

describe('systemd setup CLI parsing', () => {
  test('parse "setup systemd"', () => {
    const parsed = parseCLIArgs(['setup', 'systemd']);
    expect(parsed.command).toBe('setup');
    expect(parsed.args.target).toBe('systemd');
  });

  test('parse "setup systemd --user --dry-run"', () => {
    const parsed = parseCLIArgs(['setup', 'systemd', '--user', '--dry-run']);
    expect(parsed.command).toBe('setup');
    expect(parsed.args.target).toBe('systemd');
    expect(parsed.args.user).toBe('true');
    expect(parsed.args['dry-run']).toBe('true');
  });
});
