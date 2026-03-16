import { SignJWT, jwtVerify } from 'jose';

export interface TokenPayload {
  /** Service account id (e.g. "channels"). */
  sub: string;
}

/**
 * Sign a JWT with HS256.
 * Returns the token string and the expiry duration in seconds.
 */
export async function signToken(
  sub: string,
  secret: string,
  expiryMs: number,
): Promise<{ token: string; expiresIn: number }> {
  const secretKey = new TextEncoder().encode(secret);
  const expiresInSec = Math.floor(expiryMs / 1000);

  const token = await new SignJWT({ sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expiresInSec}s`)
    .sign(secretKey);

  return { token, expiresIn: expiresInSec };
}

/**
 * Verify a JWT signed with HS256.
 * Returns the payload if valid, or null if invalid/expired.
 */
export async function verifyToken(
  token: string,
  secret: string,
): Promise<TokenPayload | null> {
  try {
    const secretKey = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string') return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}
