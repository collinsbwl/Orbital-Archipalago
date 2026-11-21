import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { CommandContext, ViewerRole } from '../ports.js';

export const DEFAULT_ROLES_CLAIM = 'https://orbital/roles';

export type AuthConfig =
  | { mode: 'disabled'; role: ViewerRole }
  | {
      mode: 'auth0';
      /** e.g. `https://tenant.us.auth0.com/` (must match the token's `iss` exactly). */
      issuer: string;
      audience: string;
      /** Custom claim holding the role array. Default `https://orbital/roles`. */
      rolesClaim?: string;
      /** Override the key source (default: the issuer's remote JWKS). */
      jwks?: JWTVerifyGetKey;
    };

export class AuthError extends Error {}

/** Resolves a bearer token to a command context, or throws. */
export type AuthVerifier = (token: string | undefined) => Promise<CommandContext>;

export function createAuthVerifier(config: AuthConfig): AuthVerifier {
  if (config.mode === 'disabled') {
    return async () => ({ sub: 'dev', role: config.role });
  }
  const rolesClaim = config.rolesClaim ?? DEFAULT_ROLES_CLAIM;
  const jwks = config.jwks ?? createRemoteJWKSet(new URL(`${config.issuer.replace(/\/?$/, '/')}.well-known/jwks.json`));
  return async (token) => {
    if (!token) throw new AuthError('missing access token');
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience, algorithms: ['RS256'] }));
    } catch (e) {
      throw new AuthError(e instanceof Error ? e.message : 'invalid token');
    }
    if (!payload.sub) throw new AuthError('token has no sub');
    const roles = payload[rolesClaim];
    const role: ViewerRole = Array.isArray(roles) && roles.includes('operator') ? 'operator' : 'spectator';
    return { sub: payload.sub, role };
  };
}
