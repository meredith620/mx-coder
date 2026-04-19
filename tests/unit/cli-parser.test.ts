import { describe, test, expect } from 'vitest';
import { parseCLIArgs } from '../../src/cli-parser.js';

describe('CLI 命令解析', () => {
  test('parse "create bug-fix --workdir /tmp"', () => {
    const parsed = parseCLIArgs(['create', 'bug-fix', '--workdir', '/tmp']);
    expect(parsed.command).toBe('create');
    expect(parsed.args.name).toBe('bug-fix');
    expect(parsed.args.workdir).toBe('/tmp');
  });

  test('parse "attach test"', () => {
    const parsed = parseCLIArgs(['attach', 'test']);
    expect(parsed.command).toBe('attach');
    expect(parsed.args.name).toBe('test');
  });

  test('parse "takeover-status demo"', () => {
    const parsed = parseCLIArgs(['takeover-status', 'demo']);
    expect(parsed.command).toBe('takeover-status');
    expect(parsed.args.name).toBe('demo');
  });

  test('parse "takeover-cancel demo"', () => {
    const parsed = parseCLIArgs(['takeover-cancel', 'demo']);
    expect(parsed.command).toBe('takeover-cancel');
    expect(parsed.args.name).toBe('demo');
  });

  test('parse "import uuid-123 --name imported --workdir /tmp"', () => {
    const parsed = parseCLIArgs(['import', 'uuid-123', '--name', 'imported', '--workdir', '/tmp']);
    expect(parsed.command).toBe('import');
    expect(parsed.args.sessionId).toBe('uuid-123');
    expect(parsed.args.name).toBe('imported');
    expect(parsed.args.workdir).toBe('/tmp');
  });

  test('parse "list"', () => {
    const parsed = parseCLIArgs(['list']);
    expect(parsed.command).toBe('list');
  });

  test('parse "status my-session"', () => {
    const parsed = parseCLIArgs(['status', 'my-session']);
    expect(parsed.command).toBe('status');
    expect(parsed.args.name).toBe('my-session');
  });

  test('parse "remove my-session"', () => {
    const parsed = parseCLIArgs(['remove', 'my-session']);
    expect(parsed.command).toBe('remove');
    expect(parsed.args.name).toBe('my-session');
  });

  test('parse "start" daemon command', () => {
    const parsed = parseCLIArgs(['start']);
    expect(parsed.command).toBe('start');
  });

  test('parse "stop" daemon command', () => {
    const parsed = parseCLIArgs(['stop']);
    expect(parsed.command).toBe('stop');
  });

  test('parse "restart" daemon command', () => {
    const parsed = parseCLIArgs(['restart']);
    expect(parsed.command).toBe('restart');
  });

  test('parse "im-init --config /path/to/config.json" (backward compat)', () => {
    const parsed = parseCLIArgs(['im-init', '--config', '/path/to/config.json']);
    expect(parsed.command).toBe('im');
    expect(parsed.subcommand).toBe('init');
    expect(parsed.args.config).toBe('/path/to/config.json');
  });

  test('parse "im-verify" without config path (backward compat)', () => {
    const parsed = parseCLIArgs(['im-verify']);
    expect(parsed.command).toBe('im');
    expect(parsed.subcommand).toBe('verify');
  });

  test('parse "im-run my-session" (backward compat)', () => {
    const parsed = parseCLIArgs(['im-run', 'my-session']);
    expect(parsed.command).toBe('im');
    expect(parsed.subcommand).toBe('run');
    expect(parsed.args.sessionName).toBe('my-session');
  });

  test('parse "im init" 子命令风格', () => {
    const parsed = parseCLIArgs(['im', 'init']);
    expect(parsed.command).toBe('im');
    expect(parsed.subcommand).toBe('init');
  });

  test('parse "im init --plugin discord --config /path"', () => {
    const parsed = parseCLIArgs(['im', 'init', '--plugin', 'discord', '--config', '/path']);
    expect(parsed.command).toBe('im');
    expect(parsed.subcommand).toBe('init');
    expect(parsed.args.plugin).toBe('discord');
    expect(parsed.args.config).toBe('/path');
  });

  test('parse "im verify --plugin mattermost"', () => {
    const parsed = parseCLIArgs(['im', 'verify', '--plugin', 'mattermost']);
    expect(parsed.command).toBe('im');
    expect(parsed.subcommand).toBe('verify');
    expect(parsed.args.plugin).toBe('mattermost');
  });

  test('parse "im run my-session"', () => {
    const parsed = parseCLIArgs(['im', 'run', 'my-session']);
    expect(parsed.command).toBe('im');
    expect(parsed.subcommand).toBe('run');
    expect(parsed.args.sessionName).toBe('my-session');
  });

  test('"im" 无子命令抛错', () => {
    expect(() => parseCLIArgs(['im'])).toThrow(/Unknown im subcommand/);
  });

  test('"im unknown" 未知子命令抛错', () => {
    expect(() => parseCLIArgs(['im', 'unknown'])).toThrow(/Unknown im subcommand/);
  });

  test('parse "completion bash"', () => {
    const parsed = parseCLIArgs(['completion', 'bash']);
    expect(parsed.command).toBe('completion');
    expect(parsed.args.shell).toBe('bash');
  });

  test('parse "completion zsh"', () => {
    const parsed = parseCLIArgs(['completion', 'zsh']);
    expect(parsed.command).toBe('completion');
    expect(parsed.args.shell).toBe('zsh');
  });

  test('未知命令抛出错误', () => {
    expect(() => parseCLIArgs(['unknown-cmd'])).toThrow();
  });

  test('短参数 -n 映射到 name', () => {
    const parsed = parseCLIArgs(['create', '-n', 'my-session']);
    expect(parsed.args.name).toBe('my-session');
  });

  test('短参数 -s 映射到 sessionId', () => {
    const parsed = parseCLIArgs(['import', '-s', 'uuid-456']);
    expect(parsed.args.sessionId).toBe('uuid-456');
  });

  test('短参数 -p 映射到 plugin', () => {
    const parsed = parseCLIArgs(['im', 'init', '-p', 'discord']);
    expect(parsed.args.plugin).toBe('discord');
  });

  test('短参数 -c 映射到 config', () => {
    const parsed = parseCLIArgs(['im', 'verify', '-c', '/path/to/config.json']);
    expect(parsed.args.config).toBe('/path/to/config.json');
  });

  test('短参数 -C 映射到 cli', () => {
    const parsed = parseCLIArgs(['create', 'test', '-C', 'my-cli']);
    expect(parsed.args.cli).toBe('my-cli');
  });

  test('短参数 -w 映射到 workdir', () => {
    const parsed = parseCLIArgs(['create', 'test', '-w', '/tmp']);
    expect(parsed.args.workdir).toBe('/tmp');
  });

  test('短参数组合使用', () => {
    const parsed = parseCLIArgs(['create', 'test', '-n', 'named', '-w', '/tmp', '-C', 'my-cli']);
    expect(parsed.args.name).toBe('named');
    expect(parsed.args.workdir).toBe('/tmp');
    expect(parsed.args.cli).toBe('my-cli');
  });

  test('混合长短参数', () => {
    const parsed = parseCLIArgs(['im', 'init', '-p', 'discord', '--config', '/path.json']);
    expect(parsed.args.plugin).toBe('discord');
    expect(parsed.args.config).toBe('/path.json');
  });
});
