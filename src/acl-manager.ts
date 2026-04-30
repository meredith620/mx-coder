import type { Session } from './types.js';

export type AclRole = 'owner' | 'operator' | 'approver';
export type Role = AclRole; // alias for S15b tests
export type AclAction =
  | 'attach'
  | 'attach_exit'
  | 'create'
  | 'list'
  | 'status'
  | 'remove'
  | 'archive'
  | 'message'
  | 'takeover'
  | 'takeoverStatus'
  | 'takeoverCancel'
  | 'open'
  | 'import'
  | 'acl_get'
  | 'acl_grant'
  | 'acl_revoke'
  | 'reset';

export interface Actor {
  source: string;
  userId?: string;
}

export interface IMAction {
  action: string;
  [key: string]: unknown;
}

// Original S8 CLI action matrix
const PUBLIC_ACTIONS = new Set<AclAction>(['create', 'list', 'status', 'acl_get']);
const REQUIRED_ROLE: Partial<Record<AclAction, AclRole>> = {
  attach: 'owner',
  attach_exit: 'owner',
  remove: 'owner',
  archive: 'owner',
  message: 'operator',
  takeover: 'owner',
  takeoverStatus: 'owner',
  takeoverCancel: 'owner',
  open: 'owner',
  import: 'owner',
  acl_grant: 'owner',
  acl_revoke: 'owner',
  reset: 'owner',
};
const ROLE_RANK: Record<AclRole, number> = { approver: 1, operator: 2, owner: 3 };

// S15b IM entry action matrix
const ROLE_IMPLIES: Record<AclRole, AclRole[]> = {
  owner: ['owner', 'approver', 'operator'],
  approver: ['approver', 'operator'],
  operator: ['operator'],
};
const IM_ACTION_MIN_ROLE: Record<string, AclRole> = {
  send_text: 'operator',
  send_message: 'operator',
  approve: 'approver',
  deny: 'approver',
  cancel: 'approver',
  takeover_soft: 'owner',
  takeover_hard: 'owner',
};
const IM_PUBLIC_ACTIONS = new Set<string>(['list', 'view', 'status']);

export class AclManager {
  // S15b: sessionId → userId → granted roles
  private _roleStore = new Map<string, Map<string, Set<AclRole>>>();

  // S15b role management
  grantRole(sessionId: string, userId: string, role: AclRole): void {
    let sm = this._roleStore.get(sessionId);
    if (!sm) { sm = new Map(); this._roleStore.set(sessionId, sm); }
    let roles = sm.get(userId);
    if (!roles) { roles = new Set(); sm.set(userId, roles); }
    roles.add(role);
  }

  revokeRole(sessionId: string, userId: string, role: AclRole): void {
    this._roleStore.get(sessionId)?.get(userId)?.delete(role);
  }

  hasRole(sessionId: string, userId: string, role: AclRole): boolean {
    const directRoles = this._roleStore.get(sessionId)?.get(userId);
    if (!directRoles) return false;
    for (const direct of directRoles) {
      if (ROLE_IMPLIES[direct].includes(role)) return true;
    }
    return false;
  }

  private _highestRole(sessionId: string, userId: string): AclRole | null {
    const directRoles = this._roleStore.get(sessionId)?.get(userId);
    if (!directRoles || directRoles.size === 0) return null;
    if (directRoles.has('owner')) return 'owner';
    if (directRoles.has('approver')) return 'approver';
    if (directRoles.has('operator')) return 'operator';
    return null;
  }

  // S15b: IM entry authorization
  authorize(sessionId: string, userId: string, action: string): 'allow' | 'deny';
  // Original S8: CLI authorization
  authorize(actor: Actor | undefined, action: AclAction, session?: Session): 'allow' | 'deny';
  authorize(
    sessionIdOrActor: string | Actor | undefined,
    userIdOrAction: string | AclAction,
    actionOrSession?: string | Session,
  ): 'allow' | 'deny' {
    if (typeof sessionIdOrActor === 'string' && typeof userIdOrAction === 'string' && typeof actionOrSession === 'string') {
      // S15b style
      const sessionId = sessionIdOrActor;
      const userId = userIdOrAction;
      const action = actionOrSession;
      if (IM_PUBLIC_ACTIONS.has(action)) return 'allow';
      const required = IM_ACTION_MIN_ROLE[action];
      if (!required) return 'deny';
      const highest = this._highestRole(sessionId, userId);
      if (!highest) return 'deny';
      return ROLE_IMPLIES[highest].includes(required) ? 'allow' : 'deny';
    }

    // S8 style
    const actor = sessionIdOrActor as Actor | undefined;
    const action = userIdOrAction as AclAction;
    const session = actionOrSession as Session | undefined;
    if (PUBLIC_ACTIONS.has(action)) return 'allow';
    const required = REQUIRED_ROLE[action];
    if (!required) return 'allow';
    if (!actor) return 'allow';
    if (actor.source === 'cli' && !actor.userId) return 'allow';
    if (!session) return 'deny';
    const userId = actor.userId;
    if (!userId) return 'deny';
    const acl = (session as any)._acl as Map<string, AclRole> | undefined;
    if (!acl) return 'deny';
    const role = acl.get(userId);
    if (!role) return 'deny';
    return ROLE_RANK[role] >= ROLE_RANK[required] ? 'allow' : 'deny';
  }

  authorizeIMAction(sessionId: string, userId: string, imAction: IMAction): 'allow' | 'deny' {
    return this.authorize(sessionId, userId, imAction.action);
  }

  // Original S8: grant/revoke on session object
  grant(session: Session, userId: string, role: AclRole): void {
    let acl = (session as any)._acl as Map<string, AclRole> | undefined;
    if (!acl) { acl = new Map(); (session as any)._acl = acl; }
    acl.set(userId, role);
  }

  revoke(session: Session, userId: string): void {
    const acl = (session as any)._acl as Map<string, AclRole> | undefined;
    if (acl) acl.delete(userId);
  }
}
