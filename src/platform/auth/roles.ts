export const ENTITY_ROLES = ['agent', 'supervisor', 'entity_admin', 'campaign_approver'] as const;
export type EntityRole = (typeof ENTITY_ROLES)[number];
export const PLATFORM_ROLES = ['platform_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export interface Principal {
  subject: string;
  displayName: string;
  platformRoles: PlatformRole[];
  /** Roles per legal entity id, taken from the token. */
  entityRoles: Record<string, EntityRole[]>;
}

export interface TenantContext {
  legalEntityId: string;
  roles: EntityRole[];
}

/** Supervisors and admins can do everything an agent can in the inbox. */
const IMPLIES: Record<EntityRole, EntityRole[]> = {
  agent: [],
  supervisor: ['agent'],
  entity_admin: ['agent', 'supervisor'],
  campaign_approver: [],
};

export function effectiveRoles(roles: EntityRole[]): Set<EntityRole> {
  const out = new Set<EntityRole>();
  for (const r of roles) {
    out.add(r);
    for (const implied of IMPLIES[r]) out.add(implied);
  }
  return out;
}

export function hasAnyRole(ctx: TenantContext, required: EntityRole[]): boolean {
  const eff = effectiveRoles(ctx.roles);
  return required.some((r) => eff.has(r));
}
