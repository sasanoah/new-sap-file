import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../http/errors.js';
import { hasAnyRole, type EntityRole, type PlatformRole, type Principal, type TenantContext } from './roles.js';
import type { TokenVerifier } from './verifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    tenant?: TenantContext;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function authenticate(verifier: TokenVerifier) {
  return async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('unauthorized', 'Missing bearer token');
    try {
      req.principal = await verifier.verify(header.slice(7));
    } catch {
      throw new AppError('unauthorized', 'Invalid or expired token');
    }
  };
}

/**
 * Resolves the tenant from X-Legal-Entity-Id. The header must name an entity
 * listed in the caller's token; there is no implicit cross-tenant access.
 */
export function requireTenant(...roles: EntityRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const principal = req.principal;
    if (!principal) throw new AppError('unauthorized', 'Not authenticated');
    const id = req.headers['x-legal-entity-id'];
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new AppError('bad_request', 'X-Legal-Entity-Id header (UUID) is required');
    }
    const entityRoles = principal.entityRoles[id.toLowerCase()] ?? principal.entityRoles[id];
    if (!entityRoles || entityRoles.length === 0) throw new AppError('forbidden', 'No access to this legal entity');
    const ctx: TenantContext = { legalEntityId: id.toLowerCase(), roles: entityRoles };
    if (roles.length > 0 && !hasAnyRole(ctx, roles)) {
      throw new AppError('forbidden', `Requires one of: ${roles.join(', ')}`);
    }
    req.tenant = ctx;
  };
}

export function requirePlatformRole(role: PlatformRole) {
  return async (req: FastifyRequest, _reply?: FastifyReply): Promise<void> => {
    if (!req.principal?.platformRoles.includes(role)) throw new AppError('forbidden', `Requires platform role ${role}`);
  };
}

export function tenantOf(req: FastifyRequest): TenantContext {
  if (!req.tenant) throw new AppError('internal', 'Tenant context missing');
  return req.tenant;
}

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new AppError('unauthorized', 'Not authenticated');
  return req.principal;
}
