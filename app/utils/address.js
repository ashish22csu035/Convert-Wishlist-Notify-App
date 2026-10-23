// Pure email-address check shared by the worker configuration, the Settings validation (server and
// browser) and the email builder. No imports, so it is safe everywhere.
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

// "Name <a@b.com>" or "a@b.com" -> "a@b.com" (null when it is neither)
export function addressOf(value) {
  const text = String(value ?? "").trim();
  const bracketed = /<([^<>]+)>\s*$/.exec(text);
  const address = (bracketed ? bracketed[1] : text).trim();
  return ADDRESS.test(address) ? address : null;
}
