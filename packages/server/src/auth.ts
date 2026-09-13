import { srpServer } from "@fleet-manager/core";
import type { UserRecord } from "@fleet-manager/core";

export interface PendingChallenge {
  username: string;
  secret: string;
  createdAt: number;
}

export interface Session {
  token: string;
  username: string;
  sites: string[];
  createdAt: number;
}

export interface AuthOptions {
  pendingTtlMs?: number;
  now?: () => number;
  newToken?: () => string;
}

const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * SRP login flow over REST. Pure logic (no I/O): the server package
 * wires it to HTTP. Pending challenges live here with a TTL so a
 * second process restart (or a stale tab) fails closed, not open.
 */
export class Auth {
  private readonly pending = new Map<string, PendingChallenge>();
  private readonly sessions = new Map<string, Session>();
  private readonly pendingTtlMs: number;
  private readonly now: () => number;
  private readonly newToken: () => string;

  constructor(
    private readonly users: UserRecord[],
    options: AuthOptions = {},
  ) {
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.now = options.now ?? Date.now;
    this.newToken = options.newToken ?? (() => globalThis.crypto.randomUUID());
  }

  /** Step 1: client sends username, gets salt + server ephemeral. */
  async start(username: string): Promise<{ salt: string; serverEphemeral: string }> {
    const user = this.users.find((u) => u.username === username);
    // Same shape for unknown users would be nicer (anti-enumeration);
    // for now fail closed and let the API map it to 401.
    if (!user) throw new Error(`unknown user: "${username}"`);
    const ephemeral = await srpServer.generateEphemeral(user.verifier);
    this.pending.set(ephemeral.public, {
      username,
      secret: ephemeral.secret,
      createdAt: this.now(),
    });
    return { salt: user.salt, serverEphemeral: ephemeral.public };
  }

  /** Step 2: client sends proof, gets a session token. */
  async finish(input: {
    serverEphemeral: string;
    clientEphemeral: string;
    proof: string;
  }): Promise<{ token: string; username: string; sites: string[] }> {
    const challenge = this.pending.get(input.serverEphemeral);
    this.pending.delete(input.serverEphemeral);
    if (!challenge || this.now() - challenge.createdAt > this.pendingTtlMs) {
      throw new Error("challenge expired or unknown");
    }
    const user = this.users.find((u) => u.username === challenge.username);
    if (!user) throw new Error(`unknown user: "${challenge.username}"`);
    await srpServer.deriveSession(
      challenge.secret,
      input.clientEphemeral,
      user.salt,
      user.username,
      user.verifier,
      input.proof,
    );
    const session: Session = {
      token: this.newToken(),
      username: user.username,
      sites: user.sites,
      createdAt: this.now(),
    };
    this.sessions.set(session.token, session);
    return { token: session.token, username: session.username, sites: session.sites };
  }

  /** Validate a Bearer token (GET /api/me, request auth). */
  me(token: string): Pick<Session, "username" | "sites"> {
    const session = this.sessions.get(token);
    if (!session) throw new Error("invalid session");
    return { username: session.username, sites: session.sites };
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }
}
