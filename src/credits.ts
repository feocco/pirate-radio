export type CreditProvider = "xai" | "x" | "cursor";

const REPORT_TIMEOUT_MS = 10_000;
const REDACTED_BODY_LIMIT = 500;
const SERVICE = "pirate-radio";
const PAUSE_REASON: Record<CreditProvider, string> = {
  xai: "paused: xAI out of credits",
  x: "paused: X out of credits",
  cursor: "paused: Cursor out of credits",
};

const KEY_LIKE =
  /(?:crsr_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|bearer\s+\S+|api[_-]?key\s*[:=]\s*\S+)/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TEAM_ID = /\bteam[_-][A-Za-z0-9-]{4,}\b/gi;

export interface CreditReporterConfig {
  serviceUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

type CreditReport =
  | {
      provider: CreditProvider;
      service: typeof SERVICE;
      kind: "error";
      status: number;
      body: string;
      observed_at: string;
    }
  | {
      provider: "xai";
      service: typeof SERVICE;
      kind: "success";
    };

let reporterConfig: CreditReporterConfig | undefined;
let xaiOutageOpen = false;

export class CreditExhaustedError extends Error {
  readonly provider: CreditProvider;
  readonly status: number;
  readonly redactedBody: string;

  constructor(input: { provider: CreditProvider; status: number; body: string }) {
    super(PAUSE_REASON[input.provider]);
    this.name = "CreditExhaustedError";
    this.provider = input.provider;
    this.status = input.status;
    this.redactedBody = redactCreditBody(input.body);
  }
}

export function isCreditExhaustedError(error: unknown): error is CreditExhaustedError {
  return error instanceof CreditExhaustedError;
}

export function creditExhausted(input: {
  provider: CreditProvider;
  status: number;
  body: string;
}): CreditExhaustedError {
  const error = new CreditExhaustedError(input);
  if (error.provider === "xai") xaiOutageOpen = true;
  void postCreditReport({
    provider: error.provider,
    service: SERVICE,
    kind: "error",
    status: error.status,
    body: error.redactedBody,
    observed_at: resolveReporter().now().toISOString(),
  });
  return error;
}

export function noteXaiSucceeded(): void {
  if (!xaiOutageOpen) return;
  xaiOutageOpen = false;
  void postCreditReport({
    provider: "xai",
    service: SERVICE,
    kind: "success",
  }).then((delivered) => {
    if (!delivered) xaiOutageOpen = true;
  });
}

export function configureCreditReporter(config: CreditReporterConfig): void {
  reporterConfig = config;
}

export function resetCreditReporter(): void {
  reporterConfig = undefined;
  xaiOutageOpen = false;
}

export function redactCreditBody(body: string, limit = REDACTED_BODY_LIMIT): string {
  const redacted = body
    .replace(KEY_LIKE, "[redacted]")
    .replace(UUID, "[redacted]")
    .replace(TEAM_ID, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > limit ? redacted.slice(0, limit) : redacted;
}

export function cursorCreditExhausted(error: unknown): CreditExhaustedError | undefined {
  if (isCreditExhaustedError(error)) return undefined;
  const code = readStringField(error, "code");
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : readStringField(error, "message");
  const haystack = `${code} ${message}`.toLowerCase();
  if (!haystack.includes("usage_limit") && !haystack.includes("usage limit")) return undefined;
  const statusField = error && typeof error === "object" && "status" in error ? error.status : undefined;
  const status = typeof statusField === "number" ? statusField : 402;
  return creditExhausted({
    provider: "cursor",
    status,
    body: message || code,
  });
}

function readStringField(error: unknown, field: "code" | "message"): string {
  if (!error || typeof error !== "object" || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

function resolveReporter(): {
  serviceUrl?: string;
  token?: string;
  fetchImpl: typeof fetch;
  now: () => Date;
  timeoutMs: number;
} {
  return {
    serviceUrl: reporterConfig?.serviceUrl ?? process.env.HOMELAB_FUNCTIONS_URL,
    token: reporterConfig?.token ?? process.env.HOMELAB_FUNCTIONS_TOKEN,
    fetchImpl: reporterConfig?.fetchImpl ?? fetch,
    now: reporterConfig?.now ?? (() => new Date()),
    timeoutMs: reporterConfig?.timeoutMs ?? REPORT_TIMEOUT_MS,
  };
}

function postCreditReport(payload: CreditReport): Promise<boolean> {
  try {
    const reporter = resolveReporter();
    if (!reporter.serviceUrl || !reporter.token) {
      console.log(`[pirate-radio] credit report dry-run: ${payload.provider} ${payload.kind}`);
      return Promise.resolve(true);
    }
    return reporter
      .fetchImpl(new URL("/v1/credits/report", reporter.serviceUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${reporter.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(reporter.timeoutMs),
      })
      .then((response) => {
        if (!response.ok) {
          console.error(`[pirate-radio] credit report failed: ${response.status}`);
          return false;
        }
        return true;
      })
      .catch((error: unknown) => {
        console.error("[pirate-radio] credit report failed", error);
        return false;
      });
  } catch (error) {
    console.error("[pirate-radio] credit report failed", error);
    return Promise.resolve(false);
  }
}
