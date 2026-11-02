// One place that decides how a customer's email is shown to the merchant: the first character of the part before the @,
// then asterisks, then the whole domain.  ashishmehta425@gmail.com -> a*************@gmail.com
//
// This is masking for display, not encryption: the stored email is never changed, and the masked text must never be used
// to identify or look up a customer (the Shopify customer id does that). Pure and dependency-free, so the server and the
// browser agree and tests can run it directly.

// Returns the masked address, or null for anything that is not a plain email address (missing, empty, no @, no domain).
export function maskEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  const at = email.lastIndexOf("@");
  if (at < 1) return null; // no @, or nothing before it
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (/\s/.test(email) || !/^[^@\s.][^@\s]*\.[^@\s.]+$/.test(domain)) return null; // the domain needs a dot and no spaces
  const chars = [...local]; // by character, so an emoji or accented letter is not cut in half
  // A one-character local part would be shown whole by "keep the first character", so it is hidden entirely.
  return `${chars.length === 1 ? "*" : chars[0] + "*".repeat(chars.length - 1)}@${domain}`;
}
