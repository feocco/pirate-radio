import { describe, expect, test } from "vitest";
import { findTraceLeak, REDACTED, redactTraceText } from "./qa/redact-traces.js";

const session = "dGhpcy1pcy1hLWZha2Utc2Vzc2lvbi10b2tlbi12YWx1ZQ";
const networkEntry = JSON.stringify({
  request: {
    url: `http://localhost:9999/auth/callback?code=AbCdEfGhIjKlMnOp&state=StAtEvAlUe123`,
    headers: [
      { name: "Cookie", value: `pirate_radio_oidc=${session}; pirate_radio_session=${session}` },
      { name: "authorization", value: "Bearer qa-unsupported-service-token" },
      { name: "x-api-key", value: "qa-unsupported-service-token" },
      { name: "accept", value: "text/html" },
    ],
  },
  response: {
    headers: [{ name: "set-cookie", value: `pirate_radio_session=${session}; Path=/; Secure; HttpOnly` }],
  },
});

const apiRequestAction = JSON.stringify({
  method: "fetch",
  params: {
    url: "/library.json",
    headers: { authorization: "Bearer qa-unsupported-service-token", cookie: `pirate_radio_session=${session}` },
  },
});

describe("QA trace redaction", () => {
  test("redacts credential headers recorded as an API-request header map", () => {
    expect(findTraceLeak(apiRequestAction)).toBeDefined();
    const redacted = redactTraceText(apiRequestAction);
    expect(findTraceLeak(redacted)).toBeUndefined();
    expect(JSON.parse(redacted).params.headers).toEqual({ authorization: REDACTED, cookie: REDACTED });
  });

  test("detects session cookies, auth headers, and OIDC codes in raw trace text", () => {
    expect(findTraceLeak(networkEntry)).toBeDefined();
  });

  test("redacts every cookie, credential header, and OIDC parameter value", () => {
    const redacted = redactTraceText(networkEntry);
    expect(findTraceLeak(redacted)).toBeUndefined();
    expect(redacted).not.toContain(session);
    expect(redacted).not.toContain("qa-unsupported-service-token");
    expect(redacted).not.toContain("AbCdEfGhIjKlMnOp");
    expect(redacted).not.toContain("StAtEvAlUe123");
    expect(redacted).toContain(`"name":"accept","value":"text/html"`);
    expect(redacted).toContain(`code=${REDACTED}`);
    expect(JSON.parse(redacted).request.headers[0].value).toBe(REDACTED);
  });

  test("redacts credential headers embedded as escaped JSON inside another string", () => {
    const title = JSON.stringify({ title: JSON.stringify({ authorization: "Bearer qa-unsupported-service-token" }) });
    expect(findTraceLeak(title)).toBeDefined();
    const redacted = redactTraceText(title);
    expect(findTraceLeak(redacted)).toBeUndefined();
    expect(JSON.parse(JSON.parse(redacted).title)).toEqual({ authorization: REDACTED });
  });

  test("redacts credential headers written as call-log lines", () => {
    const log = JSON.stringify({ message: "  authorization: Bearer qa-unsupported-service-token" }) +
      JSON.stringify({ message: `  cookie: pirate_radio_session=${session}` });
    expect(findTraceLeak(log)).toBeDefined();
    const redacted = redactTraceText(log);
    expect(findTraceLeak(redacted)).toBeUndefined();
    expect(redacted).not.toContain("qa-unsupported-service-token");
    expect(redacted).not.toContain(session);
  });

  test("is idempotent", () => {
    const once = redactTraceText(networkEntry);
    expect(redactTraceText(once)).toBe(once);
  });
});
