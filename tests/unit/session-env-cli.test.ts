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

  test('parse "env import demo /path/to/.env"', () => {
    const parsed = parseCLIArgs(['env', 'import', 'demo', '/path/to/.env']);
    expect(parsed.command).toBe('env');
    expect(parsed.args.action).toBe('import');
    expect(parsed.args.name).toBe('demo');
    expect(parsed.args.file).toBe('/path/to/.env');
    // import action 不应该把 file path 映射到 key
    expect(parsed.args.key).toBeUndefined();
  });

  test('parse "env import demo" 缺少 file 参数', () => {
    const parsed = parseCLIArgs(['env', 'import', 'demo']);
    expect(parsed.args.action).toBe('import');
    expect(parsed.args.name).toBe('demo');
    expect(parsed.args.file).toBeUndefined();
  });

  test('parse "env list demo"', () => {
    const parsed = parseCLIArgs(['env', 'list', 'demo']);
    expect(parsed.command).toBe('env');
    expect(parsed.args.action).toBe('list');
    expect(parsed.args.name).toBe('demo');
    // list 不需要 key/value
    expect(parsed.args.key).toBeUndefined();
    expect(parsed.args.value).toBeUndefined();
  });
});
