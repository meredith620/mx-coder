import { describe, test, expect } from 'vitest';
import { parseCLIArgs } from '../../src/cli-parser.js';

describe('session env CLI parsing', () => {
  test('parse "env get demo"', () => {
    const parsed = parseCLIArgs(['env', 'get', 'demo']);
    expect(parsed.command).toBe('env');
    expect(parsed.args.action).toBe('get');
    expect(parsed.args.name).toBe('demo');
  });

  test('parse "env set demo API_KEY secret"', () => {
    const parsed = parseCLIArgs(['env', 'set', 'demo', 'API_KEY', 'secret']);
    expect(parsed.command).toBe('env');
    expect(parsed.args.action).toBe('set');
    expect(parsed.args.name).toBe('demo');
    expect(parsed.args.key).toBe('API_KEY');
    expect(parsed.args.value).toBe('secret');
  });

  test('parse "env unset demo API_KEY"', () => {
    const parsed = parseCLIArgs(['env', 'unset', 'demo', 'API_KEY']);
    expect(parsed.args.action).toBe('unset');
    expect(parsed.args.name).toBe('demo');
    expect(parsed.args.key).toBe('API_KEY');
  });

  test('parse "env clear demo"', () => {
    const parsed = parseCLIArgs(['env', 'clear', 'demo']);
    expect(parsed.args.action).toBe('clear');
    expect(parsed.args.name).toBe('demo');
  });
});
