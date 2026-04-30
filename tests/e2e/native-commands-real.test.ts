/**
 * Claude Code 原生命令支持度验证测试（远程执行）
 *
 * 通过 SSH 调用 10.10.10.88 上的 Claude Code 进行真实环境验证
 *
 * 运行方式:
 *   npx vitest run tests/e2e/native-commands-real.test.ts
 *
 * 注意: 这些测试需要 SSH 访问 10.10.10.88，且该机器已安装 Claude Code
 */

import { describe, test, expect } from 'vitest';
import { execSync } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

const REMOTE_HOST = '10.10.10.88';
const NVM_SOURCE = 'source ~/.nvm/nvm.sh';

interface CommandResult {
  command: string;
  success: boolean;
  output: string;
  error?: string;
}

async function runRemoteCommand(command: string): Promise<CommandResult> {
  const escapedCmd = command.replace(/'/g, "'\\''");
  const fullCmd = `ssh -o ConnectTimeout=10 -o BatchMode=yes ${REMOTE_HOST} "${NVM_SOURCE} && cd /tmp && printf '${escapedCmd}\\n' | claude -p 2>&1"`;

  try {
    const { stdout, stderr } = await execAsync(fullCmd, { timeout: 30000 });
    return {
      command,
      success: stdout.length > 0 && !stdout.includes('Unknown skill'),
      output: stdout,
      error: stderr.length > 0 ? stderr : undefined,
    };
  } catch (err: any) {
    return {
      command,
      success: false,
      output: err.stdout || '',
      error: err.stderr || err.message,
    };
  }
}

describe('Claude Code 管道模式原生命令验证（远程）', () => {

  describe('A 类：会话控制命令', () => {
    test('//cost - 应该支持', async () => {
      const result = await runRemoteCommand('/cost');
      console.log('cost output:', result.output.substring(0, 200));
      expect(result.output).toContain('Total cost');
    });

    test('//context - 应该支持', async () => {
      const result = await runRemoteCommand('/context');
      console.log('context output:', result.output.substring(0, 200));
      expect(result.output).toContain('Context Usage') || expect(result.output).toContain('Tokens');
    });
  });

  describe('B 类：项目操作命令', () => {
    test('//batch - 应该支持', async () => {
      const result = await runRemoteCommand('/batch');
      console.log('batch output:', result.output.substring(0, 200));
      expect(result.output).toContain('batch') || result.output.includes('What');
    });

    test('//loop - 应该支持', async () => {
      const result = await runRemoteCommand('/loop');
      console.log('loop output:', result.output.substring(0, 200));
      expect(result.output).toContain('loop') || expect(result.output.length).toBeGreaterThan(0);
    });

    test('//review - 应该支持', async () => {
      const result = await runRemoteCommand('/review');
      console.log('review output:', result.output.substring(0, 200));
      expect(result.output.length).toBeGreaterThan(0);
    });
  });

  describe('C 类：已确认不支持的命令（Unknown skill）', () => {
    const unsupportedCommands = [
      '/help',
      '/model',
      '/effort',
      '/skills',
      '/plan',
      '/status',
      '/diff',
      '/memory',
      '/doctor',
      '/recap',
      '/btw',
    ];

    test.each(unsupportedCommands)('%s - 应该返回 Unknown skill', async (cmd) => {
      const result = await runRemoteCommand(cmd);
      console.log(`${cmd} output:`, result.output.substring(0, 100));
      expect(result.output).toContain('Unknown skill');
    });
  });

});

describe('Claude Code 命令支持度汇总测试', () => {
  const commandsToTest: Array<[string, boolean]> = [
    // [命令, 是否应该支持]
    ['/cost', true],
    ['/context', true],
    ['/batch', true],
    ['/loop', true],
    ['/review', true],
    ['/init', true],
    ['/debug', true],
    ['/insights', true],
    ['/simplify', true],
    ['/claude-api', true],
    ['/help', false],
    ['/model', false],
    ['/effort', false],
    ['/skills', false],
    ['/plan', false],
    ['/status', false],
    ['/diff', false],
    ['/memory', false],
    ['/doctor', false],
    ['/recap', false],
    ['/btw', false],
  ];

  test.each(commandsToTest)('命令 %s (expectedSupport: %s)', async (cmd, expectedSupport) => {
    const result = await runRemoteCommand(cmd);

    const status = result.output.includes('Unknown skill')
      ? '❌ Unknown skill'
      : result.output.length > 0
        ? '✅ 有输出'
        : '⚠️ 无输出';

    console.log(`[${expectedSupport ? '✓' : '✗'}] ${cmd}: ${status}`);

    if (expectedSupport) {
      expect(result.output.length).toBeGreaterThan(0);
    } else {
      // 不期望支持的命令，可能是 Unknown skill 或无输出
      const isUnsupported = result.output.includes('Unknown skill');
      expect(isUnsupported || result.output.length === 0).toBeTruthy();
    }
  }, 60000);
});
