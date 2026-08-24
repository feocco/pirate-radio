import { isIP } from "node:net";

export function buildSubjectAltName(host: string): string {
  const entries: string[] = [];
  if (isIP(host)) {
    entries.push(`IP:${host}`);
  } else {
    entries.push(`DNS:${host}`);
  }
  // Keep the browser-facing loopback name valid when binding to an IP or custom host.
  if (host !== "localhost") {
    entries.push("DNS:localhost");
  }
  return entries.join(",");
}
