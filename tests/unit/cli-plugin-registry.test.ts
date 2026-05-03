import { describe, test, expect } from 'vitest';
import { getCLIPlugin, listCLIPlugins, getDefaultCLIPluginName } from '../../src/plugins/cli/registry.js';
import { ClaudeCodePlugin } from '../../src/plugins/cli/claude-code.js';
import { CodexCLIPlugin } from '../../src/plugins/cli/codex-cli.js';

describe('CLI Plugin Registry', () => {
  test('getCLIPlugin 返回 claude-code 插件实例', () => {
    const plugin = getCLIPlugin('claude-code');
    expect(plugin).toBeInstanceOf(ClaudeCodePlugin);
  });

  test('getCLIPlugin 对未知插件抛错', () => {
    expect(() => getCLIPlugin('unknown-plugin')).toThrow(/Unknown CLI plugin: unknown-plugin/);
  });

  test('getCLIPlugin 返回 codex-cli 插件实例', () => {
    const plugin = getCLIPlugin('codex-cli');
    expect(plugin).toBeInstanceOf(CodexCLIPlugin);
  });

  test('listCLIPlugins 返回已注册插件列表', () => {
    const plugins = listCLIPlugins();
    expect(plugins).toContain('claude-code');
    expect(plugins).toContain('codex-cli');
    expect(plugins.length).toBeGreaterThan(0);
  });

  test('默认 CLI 插件名为 claude-code', () => {
    expect(getDefaultCLIPluginName()).toBe('claude-code');
  });

  test('getCLIPlugin 每次调用返回新实例', () => {
    const plugin1 = getCLIPlugin('claude-code');
    const plugin2 = getCLIPlugin('claude-code');
    expect(plugin1).not.toBe(plugin2);
  });
});
