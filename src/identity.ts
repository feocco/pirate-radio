export interface ApplicationUser {
  id: string;
  issuer: string;
  subject: string;
  username: string;
  displayName: string;
  email: string;
  groups: string[];
}

export interface OidcIdentitySnapshot {
  issuer: string;
  subject: string;
  username: string;
  displayName: string;
  email: string;
  groups: string[];
}

export interface OidcTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  browserBindingHash: string;
  returnTo: string;
  expiresAt: Date;
}

export interface PlaybackProgress {
  positionSeconds: number;
  durationSeconds?: number;
  updatedAt: string;
  completedAt?: string;
}

export type SubmissionType = "feed" | "url" | "custom_text" | "automated";
export type SubmissionStatus = "queued" | "processing" | "succeeded" | "failed";

export interface Submission {
  id: string;
  slug?: string;
  type: SubmissionType;
  status: SubmissionStatus;
  title?: string;
  sourceUrl?: string;
  submittedBy?: string;
  submittedByUsername?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
