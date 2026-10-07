import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const digest = (s: string) => crypto.createHash("sha256").update(s).digest();

export type Authenticate = (authorizationHeader: string | undefined) => string | null;

/**
 * Compares SHA-256 digests with timingSafeEqual, and always checks every
 * token, so response time doesn't reveal which token (or how much of one) matched.
 */
export function createAuthenticator(tokens: ReadonlyMap<string, string>): Authenticate {
  const entries = [...tokens].map(([token, agentId]) => ({ digest: digest(token), agentId }));

  return (header) => {
    if (!header) return null;
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    if (!match) return null;

    const given = digest(match[1]!);
    let found: string | null = null;
    for (const e of entries) {
      if (crypto.timingSafeEqual(given, e.digest)) found = e.agentId;
    }
    return found;
  };
}

export function requireAuth(authenticate: Authenticate) {
  return (req: Request, res: Response, next: NextFunction) => {
    const agentId = authenticate(req.header("authorization"));
    if (!agentId) {
      // never log or echo the token itself
      console.warn(`[auth] rejected ${req.method} ${req.path} from ${req.ip}`);
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="mcp-workspace"')
        .json({ error: "unauthorized" });
      return;
    }
    res.locals.agentId = agentId;
    next();
  };
}