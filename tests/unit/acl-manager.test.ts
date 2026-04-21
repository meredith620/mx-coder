import { describe, test, expect } from 'vitest';
import { AclManager } from '../../src/acl-manager.js';

describe('AclManager — role hierarchy', () => {
  test('owner 创建时自动拥有所有角色', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'user-creator', 'owner');
    expect(acl.hasRole('sess1', 'user-creator', 'owner')).toBe(true);
    expect(acl.hasRole('sess1', 'user-creator', 'approver')).toBe(true);
    expect(acl.hasRole('sess1', 'user-creator', 'operator')).toBe(true);
  });

  test('approver 自动拥有 operator', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'u1', 'approver');
    expect(acl.hasRole('sess1', 'u1', 'approver')).toBe(true);
    expect(acl.hasRole('sess1', 'u1', 'operator')).toBe(true);
    expect(acl.hasRole('sess1', 'u1', 'owner')).toBe(false);
  });

  test('operator 只有 operator 权限', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'u1', 'operator');
    expect(acl.hasRole('sess1', 'u1', 'operator')).toBe(true);
    expect(acl.hasRole('sess1', 'u1', 'approver')).toBe(false);
    expect(acl.hasRole('sess1', 'u1', 'owner')).toBe(false);
  });

  test('revokeRole 移除角色', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'u1', 'operator');
    acl.revokeRole('sess1', 'u1', 'operator');
    expect(acl.hasRole('sess1', 'u1', 'operator')).toBe(false);
  });
});

describe('AclManager — authorize (action matrix)', () => {
  test('operator 可发消息，不可审批', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'op-user', 'operator');
    expect(acl.authorize('sess1', 'op-user', 'send_message')).toBe('allow');
    expect(acl.authorize('sess1', 'op-user', 'approve')).toBe('deny');
  });

  test('未授权用户只读，不可发消息或审批', () => {
    const acl = new AclManager();
    expect(acl.authorize('sess1', 'stranger', 'send_message')).toBe('deny');
    expect(acl.authorize('sess1', 'stranger', 'attach')).toBe('deny');
    expect(acl.authorize('sess1', 'stranger', 'list')).toBe('allow');
  });

  test('approver 可审批', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'ap-user', 'approver');
    expect(acl.authorize('sess1', 'ap-user', 'approve')).toBe('allow');
    expect(acl.authorize('sess1', 'ap-user', 'takeover_hard')).toBe('deny');
  });

  test('owner 可 takeover_hard', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'owner-user', 'owner');
    expect(acl.authorize('sess1', 'owner-user', 'takeover_hard')).toBe('allow');
  });
});

describe('AclManager — authorizeIMAction', () => {
  test('纯文本消息 operator 角色通过鉴权', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'op-user', 'operator');
    const result = acl.authorizeIMAction('sess1', 'op-user', { action: 'send_text', text: 'hello' });
    expect(result).toBe('allow');
  });


  test('cancel 动作需要 approver 角色', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'op-user', 'operator');
    const result = acl.authorizeIMAction('sess1', 'op-user', { action: 'cancel', requestId: 'r1' });
    expect(result).toBe('deny');
  });

  test('takeover_hard 动作需要 owner 角色', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'approver-user', 'approver');
    const result = acl.authorizeIMAction('sess1', 'approver-user', { action: 'takeover_hard' });
    expect(result).toBe('deny');
  });

  test('owner 可执行所有 IM 动作', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'owner-user', 'owner');
    expect(acl.authorizeIMAction('sess1', 'owner-user', { action: 'send_text', text: 'hi' })).toBe('allow');
    expect(acl.authorizeIMAction('sess1', 'owner-user', { action: 'approve', requestId: 'r1' })).toBe('allow');
    expect(acl.authorizeIMAction('sess1', 'owner-user', { action: 'takeover_hard' })).toBe('allow');
  });

  test('陌生人无法执行任何 IM 动作', () => {
    const acl = new AclManager();
    expect(acl.authorizeIMAction('sess1', 'stranger', { action: 'send_text', text: 'hi' })).toBe('deny');
    expect(acl.authorizeIMAction('sess1', 'stranger', { action: 'approve', requestId: 'r1' })).toBe('deny');
  });

  test('不同 session 的角色互不影响', () => {
    const acl = new AclManager();
    acl.grantRole('sess1', 'u1', 'owner');
    expect(acl.hasRole('sess2', 'u1', 'owner')).toBe(false);
    expect(acl.authorizeIMAction('sess2', 'u1', { action: 'send_text', text: 'hi' })).toBe('deny');
  });
});
