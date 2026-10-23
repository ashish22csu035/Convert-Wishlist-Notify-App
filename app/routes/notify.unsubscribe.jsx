import { isKnownToken, unsubscribeByToken } from "../models/unsubscribe.server";

// GET/POST /notify/unsubscribe?t=<token>   (public; the token is the only credential)
//
// GET only shows a confirmation page and changes nothing, so mail scanners and link previews that
// open the link cannot unsubscribe anyone. POST does the unsubscribe: the form on that page, and
// the "one-click" request mail clients send because of the List-Unsubscribe-Post header (RFC 8058).
// An unknown or malformed token gets the same neutral answer as any other, with no details.

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1a1a1a;line-height:1.5}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:4px;background:#000;color:#fff;cursor:pointer}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const tokenOf = (request) => new URL(request.url).searchParams.get("t") ?? "";

const NOT_FOUND = () => page("Link not valid", "<p>This link is not valid or has expired.</p>", 404);

export const loader = async ({ request }) => {
  const token = tokenOf(request);
  if (!(await isKnownToken(token))) return NOT_FOUND();
  return page(
    "Stop restock emails?",
    `<p>Confirm that you no longer want back-in-stock emails for this item.</p>
<form method="post" action="/notify/unsubscribe?t=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`,
  );
};

export const action = async ({ request }) => {
  const result = await unsubscribeByToken(tokenOf(request));
  if (result === "unknown") return NOT_FOUND();
  return page("You're unsubscribed", "<p>You won't receive any more back-in-stock emails for this item.</p>");
};
