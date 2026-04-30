import { describe, test, expect } from 'vitest';
import { parseEnvFile, maskEnvValue } from '../../src/env-file-parser.js';

describe('parseEnvFile', () => {
  test('正常导入多变量', () => {
    const content = 'API_KEY=abc123\nDB_HOST=localhost\n';
    const result = parseEnvFile(content);
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { key: 'API_KEY', value: 'abc123' },
      { key: 'DB_HOST', value: 'localhost' },
    ]);
  });

  test('支持 export 前缀', () => {
    const content = 'export SECRET=val1\nexport TOKEN=val2\n';
    const result = parseEnvFile(content);
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { key: 'SECRET', value: 'val1' },
      { key: 'TOKEN', value: 'val2' },
    ]);
  });

  test('支持注释和空行', () => {
    const content = '# this is a comment\n\nKEY=value\n  \n# another comment\n';
    const result = parseEnvFile(content);
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([{ key: 'KEY', value: 'value' }]);
  });

  test('支持单引号值', () => {
    const result = parseEnvFile("MY_VAR='hello world'\n");
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([{ key: 'MY_VAR', value: 'hello world' }]);
  });

  test('支持双引号值', () => {
    const result = parseEnvFile('MY_VAR="hello world"\n');
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([{ key: 'MY_VAR', value: 'hello world' }]);
  });

  test('非法 key 拒绝：数字开头', () => {
    const result = parseEnvFile('1BAD=val\n');
    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].line).toBe(1);
  });

  test('非法 key 拒绝：含连字符', () => {
    const result = parseEnvFile('bad-key=val\n');
    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBe(1);
  });

  test('禁止命令替换 $()', () => {
    const result = parseEnvFile('KEY=$(whoami)\n');
    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toMatch(/command substitution|unsafe/i);
  });

  test('禁止反引号命令替换', () => {
    const result = parseEnvFile('KEY=`whoami`\n');
    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBe(1);
  });

  test('禁止变量展开 $VAR', () => {
    const result = parseEnvFile('KEY=$HOME/path\n');
    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBe(1);
  });

  test('值中包含等号', () => {
    const result = parseEnvFile('KEY=a=b=c\n');
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([{ key: 'KEY', value: 'a=b=c' }]);
  });

  test('空值', () => {
    const result = parseEnvFile('KEY=\n');
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([{ key: 'KEY', value: '' }]);
  });

  test('非法行给明确错误', () => {
    const result = parseEnvFile('this is not valid\n');
    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].line).toBe(1);
  });
});

describe('maskEnvValue', () => {
  test('空值脱敏为 ****', () => {
    expect(maskEnvValue('')).toBe('****');
  });

  test('短值（长度 <= 4）脱敏为 ****', () => {
    expect(maskEnvValue('ab')).toBe('****');
    expect(maskEnvValue('abcd')).toBe('****');
  });

  test('长值（长度 > 4）脱敏为 **** + 最后 4 字符', () => {
    expect(maskEnvValue('sk-abc1234')).toBe('****1234');
    expect(maskEnvValue('12345')).toBe('****2345');
  });
});
