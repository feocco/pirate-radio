import { randomUUID } from "node:crypto";
import type { AuthenticatedRequest, Authenticator, CallbackResult, LogoutResult } from "../../src/auth.js";
import type { CreateSubmissionInput, PirateRadioStore } from "../../src/database.js";
import type { ApplicationUser, OidcIdentitySnapshot, OidcTransaction, PlaybackProgress, Submission, SubmissionStatus } from "../../src/identity.js";

export const memberUser: ApplicationUser = {
  id: "user-member",
  issuer: "https://auth.example/application/o/pirate-radio/",
  subject: "member-subject",
  username: "member",
  displayName: "Member User",
  email: "member@example.com",
  groups: ["pirate-radio-users"],
};

export const adminUser: ApplicationUser = {
  ...memberUser,
  id: "user-admin",
  subject: "admin-subject",
  username: "admin",
  displayName: "Admin User",
  email: "admin@example.com",
  groups: ["pirate-radio-users", "pirate-radio-admins"],
};

export class FakeAuthenticator implements Authenticator {
  constructor(public principal: AuthenticatedRequest | undefined = { user: adminUser, isAdmin: true }) {}
  async initialize(): Promise<void> {}
  async login(): Promise<{ location: string; transactionCookie: string }> {
    return { location: "https://auth.example/authorize", transactionCookie: "pirate_radio_oidc=test; Secure; HttpOnly; SameSite=Lax" };
  }
  async callback(): Promise<CallbackResult> {
    return { sessionCookie: "pirate_radio_session=test", transactionCookie: "pirate_radio_oidc=", returnTo: "/", user: adminUser };
  }
  async authenticate(): Promise<AuthenticatedRequest | undefined> {
    return this.principal;
  }
  async logout(): Promise<LogoutResult> {
    return {
      sessionCookie: "pirate_radio_session=; Max-Age=0",
      location: "https://auth.example/application/o/pirate-radio/end-session/?post_logout_redirect_uri=https%3A%2F%2Fpirate-radio.example.com%2F",
    };
  }
}

export class MemoryStore implements PirateRadioStore {
  users = new Map<string, ApplicationUser>([[memberUser.id, memberUser], [adminUser.id, adminUser]]);
  transactions = new Map<string, OidcTransaction>();
  sessions = new Map<string, { userId: string; expiresAt: Date }>();
  progressRows = new Map<string, PlaybackProgress>();
  submissionRows: Submission[] = [];

  async upsertUser(identity: OidcIdentitySnapshot): Promise<ApplicationUser> {
    const existing = [...this.users.values()].find((user) => user.issuer === identity.issuer && user.subject === identity.subject);
    const user = { id: existing?.id ?? randomUUID(), ...identity };
    this.users.set(user.id, user);
    return user;
  }
  async createOidcTransaction(transaction: OidcTransaction): Promise<void> {
    this.transactions.set(transaction.state, transaction);
  }
  async consumeOidcTransaction(state: string, browserBindingHash: string): Promise<OidcTransaction | undefined> {
    const transaction = this.transactions.get(state);
    if (!transaction || transaction.browserBindingHash !== browserBindingHash || transaction.expiresAt <= new Date()) return undefined;
    this.transactions.delete(state);
    return transaction;
  }
  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    this.sessions.set(tokenHash, { userId, expiresAt });
  }
  async sessionUser(tokenHash: string): Promise<ApplicationUser | undefined> {
    const session = this.sessions.get(tokenHash);
    return session && session.expiresAt > new Date() ? this.users.get(session.userId) : undefined;
  }
  async revokeSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }
  async progress(userId: string, slug: string): Promise<PlaybackProgress | undefined> {
    return this.progressRows.get(`${userId}:${slug}`);
  }
  async saveProgress(userId: string, slug: string, positionSeconds: number, durationSeconds?: number, ended = false): Promise<PlaybackProgress> {
    const key = `${userId}:${slug}`;
    const prior = this.progressRows.get(key);
    const completed = prior?.completedAt ?? (ended || (durationSeconds != null && durationSeconds > 0 && positionSeconds / durationSeconds >= 0.95) ? new Date().toISOString() : undefined);
    const value = { positionSeconds, ...(durationSeconds == null ? {} : { durationSeconds }), updatedAt: new Date().toISOString(), ...(completed ? { completedAt: completed } : {}) };
    this.progressRows.set(key, value);
    return value;
  }
  async completedUsers(slug: string): Promise<ApplicationUser[]> {
    return [...this.users.values()].filter((user) => this.progressRows.get(`${user.id}:${slug}`)?.completedAt);
  }
  async createSubmission(input: CreateSubmissionInput): Promise<Submission> {
    const now = new Date().toISOString();
    const value: Submission = { id: randomUUID(), type: input.type, status: "queued", createdAt: now, updatedAt: now, ...(input.slug ? { slug: input.slug } : {}), ...(input.title ? { title: input.title } : {}), ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}), ...(input.submittedBy ? { submittedBy: input.submittedBy.id, submittedByUsername: input.submittedBy.username } : {}) };
    this.submissionRows.unshift(value);
    return value;
  }
  async updateSubmission(id: string, status: SubmissionStatus, update: { slug?: string; error?: string } = {}): Promise<void> {
    const item = this.submissionRows.find((candidate) => candidate.id === id);
    if (item) Object.assign(item, { status, updatedAt: new Date().toISOString(), ...update });
  }
  async submissions(limit = 100): Promise<Submission[]> {
    return this.submissionRows.slice(0, limit);
  }
  async firstSuccessfulSubmitter(slug: string): Promise<ApplicationUser | undefined> {
    const submission = [...this.submissionRows].reverse().find((item) => item.slug === slug && item.status === "succeeded" && item.submittedBy);
    return submission?.submittedBy ? this.users.get(submission.submittedBy) : undefined;
  }
}
