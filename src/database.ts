import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import type {
  ApplicationUser,
  OidcIdentitySnapshot,
  OidcTransaction,
  PlaybackProgress,
  Submission,
  SubmissionStatus,
  SubmissionType,
} from "./identity.js";
import { progressPath, readLegacyDefaultProgress } from "./progress.js";

const migrations = [
  `
    CREATE TABLE app_users (
      id text PRIMARY KEY,
      issuer text NOT NULL,
      subject text NOT NULL,
      username text NOT NULL,
      display_name text NOT NULL,
      email text NOT NULL,
      groups_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (issuer, subject)
    );
    CREATE TABLE sessions (
      token_hash text PRIMARY KEY,
      user_id text NOT NULL REFERENCES app_users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE oidc_transactions (
      state text PRIMARY KEY,
      nonce text NOT NULL,
      code_verifier text NOT NULL,
      browser_binding_hash text NOT NULL,
      return_to text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE playback_progress (
      user_id text NOT NULL REFERENCES app_users(id),
      slug text NOT NULL,
      position_seconds double precision NOT NULL,
      duration_seconds double precision,
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      PRIMARY KEY (user_id, slug)
    );
    CREATE TABLE submissions (
      id text PRIMARY KEY,
      slug text,
      type text NOT NULL,
      status text NOT NULL,
      title text,
      source_url text,
      submitted_by text REFERENCES app_users(id),
      submitted_by_username text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX submissions_slug_created_idx ON submissions (slug, created_at);
    CREATE TABLE legacy_imports (
      import_key text PRIMARY KEY,
      user_id text NOT NULL REFERENCES app_users(id),
      source_count integer NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now()
    );
  `,
];

export interface CreateSubmissionInput {
  slug?: string;
  type: SubmissionType;
  title?: string;
  sourceUrl?: string;
  submittedBy?: ApplicationUser;
}

export interface PirateRadioStore {
  upsertUser(identity: OidcIdentitySnapshot): Promise<ApplicationUser>;
  createOidcTransaction(transaction: OidcTransaction): Promise<void>;
  consumeOidcTransaction(state: string, browserBindingHash: string): Promise<OidcTransaction | undefined>;
  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  sessionUser(tokenHash: string): Promise<ApplicationUser | undefined>;
  revokeSession(tokenHash: string): Promise<void>;
  progress(userId: string, slug: string): Promise<PlaybackProgress | undefined>;
  saveProgress(userId: string, slug: string, positionSeconds: number, durationSeconds?: number, ended?: boolean): Promise<PlaybackProgress>;
  completedUsers(slug: string): Promise<ApplicationUser[]>;
  createSubmission(input: CreateSubmissionInput): Promise<Submission>;
  updateSubmission(id: string, status: SubmissionStatus, update?: { slug?: string; error?: string }): Promise<void>;
  submissions(limit?: number): Promise<Submission[]>;
  firstSuccessfulSubmitter(slug: string): Promise<ApplicationUser | undefined>;
}

export class PirateRadioDatabase implements PirateRadioStore {
  readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const [index, sql] of migrations.entries()) {
        const version = index + 1;
        const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
        if (existing.rowCount) continue;
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertUser(identity: OidcIdentitySnapshot): Promise<ApplicationUser> {
    const result = await this.pool.query(
      `INSERT INTO app_users (id, issuer, subject, username, display_name, email, groups_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (issuer, subject) DO UPDATE SET
         username = EXCLUDED.username, display_name = EXCLUDED.display_name,
         email = EXCLUDED.email, groups_json = EXCLUDED.groups_json, updated_at = now()
       RETURNING *`,
      [randomUUID(), identity.issuer, identity.subject, identity.username, identity.displayName, identity.email, JSON.stringify(identity.groups)],
    );
    return mapUser(result.rows[0]);
  }

  async applicationUser(userId: string): Promise<ApplicationUser | undefined> {
    const result = await this.pool.query("SELECT * FROM app_users WHERE id = $1", [userId]);
    return result.rowCount ? mapUser(result.rows[0]) : undefined;
  }

  async createOidcTransaction(transaction: OidcTransaction): Promise<void> {
    await this.pool.query(
      `INSERT INTO oidc_transactions (state, nonce, code_verifier, browser_binding_hash, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [transaction.state, transaction.nonce, transaction.codeVerifier, transaction.browserBindingHash, transaction.returnTo, transaction.expiresAt],
    );
  }

  async consumeOidcTransaction(state: string, browserBindingHash: string): Promise<OidcTransaction | undefined> {
    const result = await this.pool.query(
      `DELETE FROM oidc_transactions
       WHERE state = $1 AND browser_binding_hash = $2 AND expires_at > now()
       RETURNING *`,
      [state, browserBindingHash],
    );
    return result.rowCount ? mapOidcTransaction(result.rows[0]) : undefined;
  }

  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [tokenHash, userId, expiresAt]);
  }

  async sessionUser(tokenHash: string): Promise<ApplicationUser | undefined> {
    const result = await this.pool.query(
      `SELECT u.* FROM sessions s JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    return result.rowCount ? mapUser(result.rows[0]) : undefined;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async progress(userId: string, slug: string): Promise<PlaybackProgress | undefined> {
    const result = await this.pool.query("SELECT * FROM playback_progress WHERE user_id = $1 AND slug = $2", [userId, slug]);
    return result.rowCount ? mapProgress(result.rows[0]) : undefined;
  }

  async saveProgress(userId: string, slug: string, positionSeconds: number, durationSeconds?: number, ended = false): Promise<PlaybackProgress> {
    const position = normalizeSeconds(positionSeconds);
    const duration = durationSeconds == null ? undefined : normalizeSeconds(durationSeconds);
    const completes = ended || (duration != null && duration > 0 && position / duration >= 0.95);
    const result = await this.pool.query(
      `INSERT INTO playback_progress (user_id, slug, position_seconds, duration_seconds, completed_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END)
       ON CONFLICT (user_id, slug) DO UPDATE SET
         position_seconds = EXCLUDED.position_seconds,
         duration_seconds = EXCLUDED.duration_seconds,
         updated_at = now(),
         completed_at = COALESCE(playback_progress.completed_at, EXCLUDED.completed_at)
       RETURNING *`,
      [userId, slug, position, duration, completes],
    );
    return mapProgress(result.rows[0]);
  }

  async completedUsers(slug: string): Promise<ApplicationUser[]> {
    const result = await this.pool.query(
      `SELECT u.* FROM playback_progress p JOIN app_users u ON u.id = p.user_id
       WHERE p.slug = $1 AND p.completed_at IS NOT NULL ORDER BY lower(u.username), u.id`,
      [slug],
    );
    return result.rows.map(mapUser);
  }

  async createSubmission(input: CreateSubmissionInput): Promise<Submission> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO submissions (id, slug, type, status, title, source_url, submitted_by, submitted_by_username)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7) RETURNING *`,
      [id, input.slug, input.type, input.title, input.sourceUrl, input.submittedBy?.id, input.submittedBy?.username],
    );
    return mapSubmission(result.rows[0]);
  }

  async updateSubmission(id: string, status: SubmissionStatus, update: { slug?: string; error?: string } = {}): Promise<void> {
    await this.pool.query(
      `UPDATE submissions SET status = $2, slug = COALESCE($3, slug), error = $4, updated_at = now() WHERE id = $1`,
      [id, status, update.slug, update.error],
    );
  }

  async submissions(limit = 100): Promise<Submission[]> {
    const result = await this.pool.query("SELECT * FROM submissions ORDER BY created_at DESC LIMIT $1", [Math.max(1, Math.min(limit, 500))]);
    return result.rows.map(mapSubmission);
  }

  async firstSuccessfulSubmitter(slug: string): Promise<ApplicationUser | undefined> {
    const result = await this.pool.query(
      `SELECT u.* FROM submissions s JOIN app_users u ON u.id = s.submitted_by
       WHERE s.slug = $1 AND s.status = 'succeeded' ORDER BY s.created_at, s.id LIMIT 1`,
      [slug],
    );
    return result.rowCount ? mapUser(result.rows[0]) : undefined;
  }

  async importLegacyProgress(libraryDir: string, userId: string): Promise<{ sourceCount: number; destinationCount: number; backupPath: string; alreadyImported: boolean }> {
    const source = await readLegacyDefaultProgress(libraryDir);
    const sourceCount = Object.keys(source).length;
    const sourcePath = progressPath(libraryDir);
    const backupPath = join(libraryDir, `progress.pre-postgres.${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query("SELECT source_count, user_id FROM legacy_imports WHERE import_key = 'progress-json-v1'");
      if (prior.rowCount) {
        if (String(prior.rows[0].user_id) !== userId) throw new Error("Legacy progress was already imported for a different user.");
        const count = await progressCount(client, userId);
        await client.query("ROLLBACK");
        return { sourceCount: Number(prior.rows[0].source_count), destinationCount: count, backupPath: "", alreadyImported: true };
      }
      await copyFile(sourcePath, backupPath);
      for (const [slug, progress] of Object.entries(source)) {
        await client.query(
          `INSERT INTO playback_progress (user_id, slug, position_seconds, duration_seconds, updated_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, slug) DO NOTHING`,
          [userId, slug, progress.positionSeconds, progress.durationSeconds, progress.updatedAt],
        );
      }
      await client.query("INSERT INTO legacy_imports (import_key, user_id, source_count) VALUES ('progress-json-v1', $1, $2)", [userId, sourceCount]);
      const destinationCount = await progressCount(client, userId);
      if (destinationCount !== sourceCount) throw new Error(`Legacy progress count mismatch: source=${sourceCount}, destination=${destinationCount}`);
      await client.query("COMMIT");
      return { sourceCount, destinationCount, backupPath, alreadyImported: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async exportLegacyProgress(libraryDir: string, userId: string): Promise<{ count: number; path: string }> {
    const result = await this.pool.query("SELECT * FROM playback_progress WHERE user_id = $1 ORDER BY slug", [userId]);
    const users = { default: Object.fromEntries(result.rows.map((row) => [String(row.slug), mapProgress(row)])) };
    const output = { version: 1, updatedAt: new Date().toISOString(), users };
    await mkdir(libraryDir, { recursive: true });
    const path = join(libraryDir, `progress.rollback.${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    await rename(temporary, path);
    JSON.parse(await readFile(path, "utf8"));
    return { count: result.rowCount ?? 0, path };
  }
}

async function progressCount(client: PoolClient, userId: string): Promise<number> {
  const result = await client.query("SELECT count(*)::integer AS count FROM playback_progress WHERE user_id = $1", [userId]);
  return Number(result.rows[0].count);
}

function mapUser(row: Record<string, unknown>): ApplicationUser {
  return { id: String(row.id), issuer: String(row.issuer), subject: String(row.subject), username: String(row.username), displayName: String(row.display_name), email: String(row.email), groups: Array.isArray(row.groups_json) ? row.groups_json.map(String) : [] };
}

function mapOidcTransaction(row: Record<string, unknown>): OidcTransaction {
  return { state: String(row.state), nonce: String(row.nonce), codeVerifier: String(row.code_verifier), browserBindingHash: String(row.browser_binding_hash), returnTo: String(row.return_to), expiresAt: new Date(String(row.expires_at)) };
}

function mapProgress(row: Record<string, unknown>): PlaybackProgress {
  return {
    positionSeconds: Number(row.position_seconds),
    ...(row.duration_seconds == null ? {} : { durationSeconds: Number(row.duration_seconds) }),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    ...(row.completed_at == null ? {} : { completedAt: new Date(String(row.completed_at)).toISOString() }),
  };
}

function mapSubmission(row: Record<string, unknown>): Submission {
  return {
    id: String(row.id),
    ...(row.slug == null ? {} : { slug: String(row.slug) }),
    type: String(row.type) as SubmissionType,
    status: String(row.status) as SubmissionStatus,
    ...(row.title == null ? {} : { title: String(row.title) }),
    ...(row.source_url == null ? {} : { sourceUrl: String(row.source_url) }),
    ...(row.submitted_by == null ? {} : { submittedBy: String(row.submitted_by) }),
    ...(row.submitted_by_username == null ? {} : { submittedByUsername: String(row.submitted_by_username) }),
    ...(row.error == null ? {} : { error: String(row.error) }),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function normalizeSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 1000) / 1000;
}
