import type { Session } from './types.js';

export type AclRole = 'owner' | 'operator' | 'approver';
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
  | 'acl_get'
  | 'acl_grant'
  | 'acl_revoke'
  | 'reset';

export interface Actor {
  source: string;
  userId?: string;
}

// Actions that require no role (anyone can perform)
const PUBLIC_ACTIONS = new Set<AclAction>(['create', 'list', 'status', 'acl_get']);

// Minimum required role per action
const REQUIRED_ROLE: Partial<Record<AclAction, AclRole>> = {
  attach: 'owner',
  attach_exit: 'owner',
  remove: 'owner',
  archive: 'owner',
  message: 'operator',
  takeover: 'owner',
  acl_grant: 'owner',
  acl_revoke: 'owner',
  reset: 'owner',
};

const ROLE_RANK: Record<AclRole, number> = { approver: 1, operator: 2, owner: 3 };

export class AclManager {
  /**
   * Authorize an actor performing action on session.
   * Returns 'allow' or 'deny'.
   *
   * Rules:
   * - Public actions: always allow.
   * - CLI source with no userId: treated as local owner (allow all).
   * - Otherwise check session ACL for required role.
   * - On create: creator becomes owner (handled by Daemon after creation).
   */
  authorize(actor: Actor | undefined, action: AclAction, session?: Session): 'allow' | 'deny' {
    if (PUBLIC_ACTIONS.has(action)) return 'allow';

    const required = REQUIRED_ROLE[action];
    if (!required) return 'allow';

    // No actor info — treat as local CLI (allow all)
    if (!actor) return 'allow';

    // Local CLI with no userId (terminal user) — treat as owner
    if (actor.source === 'cli' && !actor.userId) return 'allow';

    // Check session ACL
    if (!session) return 'deny';

    const userId = actor.userId;
    if (!userId) return 'deny';

    const acl = (session as any)._acl as Map<string, AclRole> | undefined;
    if (!acl) return 'deny';

    const role = acl.get(userId);
    if (!role) return 'deny';

    return ROLE_RANK[role] >= ROLE_RANK[required] ? 'allow' : 'deny';
  }

  /**
   * Grant a role to userId on session. Mutates session._acl.
   */
  grant(session: Session, userId: string, role: AclRole): void {
    let acl = (session as any)._acl as Map<string, AclRole> | undefined;
    if (!acl) {
      acl = new Map();
      (session as any)._acl = acl;
    }
    acl.set(userId, role);
  }

  /**
   * Revoke all roles for userId on session.
   */
  revoke(session: Session, userId: string): void {
    const acl = (session as any)._acl as Map<string, AclRole> | undefined;
    if (acl) acl.delete(userId);
  }
}
