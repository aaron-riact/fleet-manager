import type { PendingChallenge, Session } from "./auth.js";

/**
 * Session + challenge persistence. Memory for tests, SQLite in prod —
 * Auth never knows which. All methods async so file-backed stores fit.
 */
export interface SessionStore {
  saveSession(session: Session): Promise<void>;
  getSession(token: string): Promise<Session | undefined>;
  deleteSession(token: string): Promise<void>;
  saveChallenge(serverEphemeral: string, challenge: PendingChallenge): Promise<void>;
  /** Take (get + delete) a challenge; single-use by construction. */
  takeChallenge(serverEphemeral: string): Promise<PendingChallenge | undefined>;
  /** Drop expired challenges and sessions. Returns counts removed. */
  purgeExpired(now: number, pendingTtlMs: number, sessionTtlMs: number): Promise<{ challenges: number; sessions: number }>;
  close?(): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<string, PendingChallenge>();

  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.token, session);
  }

  async getSession(token: string): Promise<Session | undefined> {
    return this.sessions.get(token);
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async saveChallenge(serverEphemeral: string, challenge: PendingChallenge): Promise<void> {
    this.challenges.set(serverEphemeral, challenge);
  }

  async takeChallenge(serverEphemeral: string): Promise<PendingChallenge | undefined> {
    const challenge = this.challenges.get(serverEphemeral);
    this.challenges.delete(serverEphemeral);
    return challenge;
  }

  async purgeExpired(
    now: number,
    pendingTtlMs: number,
    sessionTtlMs: number,
  ): Promise<{ challenges: number; sessions: number }> {
    let challenges = 0;
    let sessions = 0;
    for (const [key, c] of this.challenges) {
      if (now - c.createdAt > pendingTtlMs) {
        this.challenges.delete(key);
        challenges++;
      }
    }
    for (const [key, s] of this.sessions) {
      if (now - s.createdAt > sessionTtlMs) {
        this.sessions.delete(key);
        sessions++;
      }
    }
    return { challenges, sessions };
  }
}
