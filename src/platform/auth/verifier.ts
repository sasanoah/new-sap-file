import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { ENTITY_ROLES, PLATFORM_ROLES, type Principal } from './roles.js';

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().optional(),
  legal_entities: z.record(z.string().uuid(), z.array(z.enum(ENTITY_ROLES))).default({}),
  platform_roles: z.array(z.enum(PLATFORM_ROLES)).default([]),
});

export function principalFromClaims(payload: JWTPayload): Principal {
  const claims = ClaimsSchema.parse(payload);
  return {
    subject: claims.sub,
    displayName: claims.name ?? claims.sub,
    platformRoles: claims.platform_roles,
    entityRoles: claims.legal_entities,
  };
}

/**
 * Verifies bearer tokens issued by the group identity provider. Signature,
 * issuer, audience and expiry are all enforced by jose.
 */
export class JwtVerifier implements TokenVerifier {
  private readonly key: Parameters<typeof jwtVerify>[1];

  constructor(
    private readonly opts: { issuer: string; audience: string; jwksUrl?: string; hs256Secret?: string },
  ) {
    if (opts.jwksUrl) this.key = createRemoteJWKSet(new URL(opts.jwksUrl));
    else if (opts.hs256Secret) this.key = new TextEncoder().encode(opts.hs256Secret);
    else throw new Error('JwtVerifier needs jwksUrl or hs256Secret');
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.key as never, {
      issuer: this.opts.issuer,
      audience: this.opts.audience,
      algorithms: this.opts.jwksUrl ? ['RS256', 'ES256', 'PS256'] : ['HS256'],
      clockTolerance: 30,
    });
    return principalFromClaims(payload);
  }
}
