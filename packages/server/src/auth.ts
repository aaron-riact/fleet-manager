import { srpServer } from "@fleet-manager/core";
import type { UserRecord } from "@fleet-manager/core";
import { MemorySessionStore } from "./sessions.js";
import type { SessionStore } from "./sessions.js";

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
  sessionTtlMs?: number;
  maxPendingChallenges?: number;
  now?: () => number;
  newToken?: () => string;
  store?: SessionStore;
}

const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_PENDING = 1000;

/**
 * SRP login flow over REST. Pure logic (no I/O besides the injected
 * store): the server package wires it to HTTP. Pending challenges are
 * single-use with a TTL; sessions expire after sessionTtlMs.
 */
export class Auth {
  private readonly pendingTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly maxPendingChallenges: number;
  private readonly now: () => number;
  private readonly newToken: () => string;
  private readonly store: SessionStore;

  constructor(
    private readonly users: UserRecord[],
    options: AuthOptions = {},
  ) {
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxPendingChallenges = options.maxPendingChallenges ?? DEFAULT_MAX_PENDING;
    this.now = options.now ?? Date.now;
    this.newToken = options.newToken ?? (() => globalThis.crypto.randomUUID());
    this.store = options.store ?? new MemorySessionStore();
  }

  /** Step 1: client sends username, gets salt + server ephemeral. */
  async start(username: string): Promise<{ salt: string; serverEphemeral: string }> {
    const user = this.users.find((u) => u.username === username);
    // Same shape for unknown users would be nicer (anti-enumeration);
    // for now fail closed and let the API map it to 401.
    if (!user) throw new Error(`unknown user: "${username}"`);
    // Count only challenges still inside the TTL. Counting expired ones
    // too meant abandoned logins piled up until every login 429'd, and
    // only a restart (the one purge) cleared it.
    const liveSince = this.now() - this.pendingTtlMs;
    if ((await this.store.countChallenges(liveSince)) >= this.maxPendingChallenges) {
      await this.store.purgeExpired(this.now(), this.pendingTtlMs, this.sessionTtlMs);
      if ((await this.store.countChallenges(liveSince)) >= this.maxPendingChallenges) {
        throw Object.assign(new Error("too many pending logins"), { status: 429 });
      }
    }
    const ephemeral = await srpServer.generateEphemeral(user.verifier);
    await this.store.saveChallenge(ephemeral.public, {
      username,
      secret: ephemeral.secret,
      createdAt: this.now(),
    });
    return { salt: user.salt, serverEphemeral: ephemeral.public };
  }

  /** Step 2: client sends proof, gets a session token + server proof (mutual auth). */
  async finish(input: {
    serverEphemeral: string;
    clientEphemeral: string;
    proof: string;
  }): Promise<{ token: string; username: string; sites: string[]; proof: string }> {
    const challenge = await this.store.takeChallenge(input.serverEphemeral);
    if (!challenge || this.now() - challenge.createdAt > this.pendingTtlMs) {
      throw new Error("challenge expired or unknown");
    }
    const user = this.users.find((u) => u.username === challenge.username);
    if (!user) throw new Error(`unknown user: "${challenge.username}"`);
    const session = await srpServer.deriveSession(
      challenge.secret,
      input.clientEphemeral,
      user.salt,
      user.username,
      user.verifier,
      input.proof,
    );
    const token = this.newToken();
    await this.store.saveSession({ token, username: user.username, sites: user.sites, createdAt: this.now() });
    return { token, username: user.username, sites: user.sites, proof: session.proof };
  }

  /** Validate a Bearer token (GET /api/me, request auth). */
  async me(token: string): Promise<Pick<Session, "username" | "sites">> {
    const session = await this.store.getSession(token);
    if (!session) throw new Error("invalid session");
    if (this.now() - session.createdAt > this.sessionTtlMs) {
      await this.store.deleteSession(token);
      throw new Error("session expired");
    }
    return { username: session.username, sites: session.sites };
  }

  async logout(token: string): Promise<void> {
    await this.store.deleteSession(token);
  }

  /** Evict expired challenges and sessions (call at boot, then rarely). */
  async purge(now = this.now()): Promise<{ challenges: number; sessions: number }> {
    return this.store.purgeExpired(now, this.pendingTtlMs, this.sessionTtlMs);
  }
}
