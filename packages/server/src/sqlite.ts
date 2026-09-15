import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { PendingChallenge, Session } from "./auth.js";
import type { SessionStore } from "./sessions.js";

/**
 * A session token is a bearer credential: whoever holds one is the user.
 * Storing it verbatim would make read access to the file equivalent to
 * every operator's password, so only its digest is written — the same
 * reason password files hold hashes. Lookups hash the presented token
 * and compare digests, so the plaintext never touches disk.
 *
 * Challenge secrets are different: SRP has to use the secret to finish
 * the handshake, so it cannot be hashed. They live at most pendingTtlMs
 * (5 minutes) and are useless without the client's matching proof.
 */
const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * File-backed session store. One file next to users.json
 * (SESSIONS_FILE, default data/sessions.db). Survives restarts;
 * expiry is still enforced by Auth + purge.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      tokenHash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      sites TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS challenges (
      serverEphemeral TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      secret TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )`);
  }

  async saveSession(session: Session): Promise<void> {
    this.db
      .query("INSERT OR REPLACE INTO sessions (tokenHash, username, sites, createdAt) VALUES (?, ?, ?, ?)")
      .run(tokenKey(session.token), session.username, JSON.stringify(session.sites), session.createdAt);
  }

  async getSession(token: string): Promise<Session | undefined> {
    const row = this.db
      .query("SELECT username, sites, createdAt FROM sessions WHERE tokenHash = ?")
      .get(tokenKey(token)) as { username: string; sites: string; createdAt: number } | null;
    if (!row) return undefined;
    return { token, username: row.username, sites: JSON.parse(row.sites) as string[], createdAt: row.createdAt };
  }

  async deleteSession(token: string): Promise<void> {
    this.db.query("DELETE FROM sessions WHERE tokenHash = ?").run(tokenKey(token));
  }

  async saveChallenge(serverEphemeral: string, challenge: PendingChallenge): Promise<void> {
    this.db
      .query("INSERT OR REPLACE INTO challenges (serverEphemeral, username, secret, createdAt) VALUES (?, ?, ?, ?)")
      .run(serverEphemeral, challenge.username, challenge.secret, challenge.createdAt);
  }

  async takeChallenge(serverEphemeral: string): Promise<PendingChallenge | undefined> {
    // DELETE ... RETURNING in one statement. A SELECT followed by a
    // DELETE lets two concurrent finishes both read the same row, which
    // is exactly the single-use guarantee the interface promises.
    const row = this.db
      .query("DELETE FROM challenges WHERE serverEphemeral = ? RETURNING username, secret, createdAt")
      .get(serverEphemeral) as { username: string; secret: string; createdAt: number } | null;
    if (!row) return undefined;
    return { username: row.username, secret: row.secret, createdAt: row.createdAt };
  }

  async countChallenges(since: number): Promise<number> {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM challenges WHERE createdAt >= ?")
      .get(since) as { n: number };
    return row.n;
  }

  async purgeExpired(
    now: number,
    pendingTtlMs: number,
    sessionTtlMs: number,
  ): Promise<{ challenges: number; sessions: number }> {
    const challenges = this.db
      .query("DELETE FROM challenges WHERE createdAt < ? RETURNING serverEphemeral")
      .all(now - pendingTtlMs) as unknown[];
    const sessions = this.db
      .query("DELETE FROM sessions WHERE createdAt < ? RETURNING tokenHash")
      .all(now - sessionTtlMs) as unknown[];
    return { challenges: challenges.length, sessions: sessions.length };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
