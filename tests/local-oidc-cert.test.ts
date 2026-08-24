import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildSubjectAltName } from "../src/dev/oidcCert.js";

describe("local OIDC certificate SAN", () => {
  test("classifies localhost as DNS only", () => {
    expect(buildSubjectAltName("localhost")).toBe("DNS:localhost");
  });

  test("classifies IPv4 loopback as IP and adds DNS localhost alias", () => {
    expect(buildSubjectAltName("127.0.0.1")).toBe("IP:127.0.0.1,DNS:localhost");
  });

  test("classifies IPv6 loopback as IP and adds DNS localhost alias", () => {
    expect(buildSubjectAltName("::1")).toBe("IP:::1,DNS:localhost");
  });

  test("classifies other hostnames as DNS", () => {
    expect(buildSubjectAltName("oidc.dev.local")).toBe("DNS:oidc.dev.local,DNS:localhost");
  });

  test("openssl accepts the SAN for localhost", () => {
    const dir = mkdtempSync(join(tmpdir(), "pirate-radio-oidc-cert-"));
    try {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1",
        "-subj", "/CN=localhost", "-addext", `subjectAltName=${buildSubjectAltName("localhost")}`,
      ], { stdio: "pipe" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("openssl accepts the SAN for 127.0.0.1", () => {
    const dir = mkdtempSync(join(tmpdir(), "pirate-radio-oidc-cert-"));
    try {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1",
        "-subj", "/CN=127.0.0.1", "-addext", `subjectAltName=${buildSubjectAltName("127.0.0.1")}`,
      ], { stdio: "pipe" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
