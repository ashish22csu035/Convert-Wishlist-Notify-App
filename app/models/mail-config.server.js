// Configuration for the email worker, read from environment variables.
// Pure: no database or Shopify imports, so it can be checked before anything else is loaded.
// Errors name the VARIABLES that are wrong, never their values.

import { addressOf } from "../utils/address";
export { addressOf };

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid worker configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function publicBaseUrl(raw) {
  try {
    const url = new URL(String(raw ?? "").trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Everything the worker needs. SHOPIFY_* are needed because current product details are read from the
// Admin API with the shop's own (refreshing) token. The public base URL builds the unsubscribe link.
export function readWorkerConfig(env = process.env) {
  const problems = [];
  const need = (name) => {
    const value = String(env[name] ?? "").trim();
    if (!value) problems.push(`${name} is missing`);
    return value;
  };

  const host = need("SMTP_HOST");
  const portText = need("SMTP_PORT");
  const user = need("SMTP_USER");
  const pass = need("SMTP_PASS");
  const mailFrom = need("MAIL_FROM");
  need("SHOPIFY_API_KEY");
  need("SHOPIFY_API_SECRET");

  const port = Number(portText);
  if (portText && !(Number.isInteger(port) && port > 0 && port < 65536)) problems.push("SMTP_PORT must be a port number");
  const from = mailFrom ? addressOf(mailFrom) : null;
  if (mailFrom && !from) problems.push("MAIL_FROM must be an email address");

  const baseRaw = env.APP_PUBLIC_URL || env.SHOPIFY_APP_URL;
  const baseUrl = publicBaseUrl(baseRaw);
  if (!baseRaw) problems.push("APP_PUBLIC_URL (or SHOPIFY_APP_URL) is missing");
  else if (!baseUrl) problems.push("APP_PUBLIC_URL (or SHOPIFY_APP_URL) must be an https URL");

  const interval = Number(env.WORKER_INTERVAL_MS ?? 15000);
  if (env.WORKER_INTERVAL_MS !== undefined && !(Number.isFinite(interval) && interval >= 1000)) {
    problems.push("WORKER_INTERVAL_MS must be a number of at least 1000");
  }

  if (problems.length) throw new ConfigError(problems);

  const secureText = String(env.SMTP_SECURE ?? "").trim().toLowerCase();
  return {
    smtp: {
      host,
      port,
      secure: secureText ? secureText === "true" : port === 465,
      auth: { user, pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    },
    mailFrom: from,
    baseUrl,
    intervalMs: interval,
  };
}
