import { addressOf } from "./mail-config.server";

// Builds the back-in-stock email. Pure: everything comes in as arguments. Returns null when the
// required product information is missing, so nothing is ever sent with an invented title or link.

const clean = (value, max) =>
  // eslint-disable-next-line no-control-regex
  String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// https product link for the exact variant, from Shopify's own storefront URL when it has one,
// otherwise from the shop's domain and the product handle.
export function productLink({ onlineStoreUrl, handle, shopDomain, variantGid }) {
  const variantId = String(variantGid ?? "").split("/").pop();
  if (!/^[0-9]{1,20}$/.test(variantId)) return null;
  let url;
  try {
    if (onlineStoreUrl) url = new URL(onlineStoreUrl);
    else if (handle && /^[a-z0-9._~%-]+$/i.test(handle) && shopDomain) url = new URL(`https://${shopDomain}/products/${encodeURIComponent(handle)}`);
    else return null;
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  url.search = "";
  url.hash = "";
  url.searchParams.set("variant", variantId);
  return url.toString();
}

export function buildRestockEmail({ shop, settings, product, variantGid, recipient, mailFrom, unsubscribeLink, messageId }) {
  const to = addressOf(recipient);
  const title = clean(product?.productTitle, 200);
  const link = productLink({ onlineStoreUrl: product?.onlineStoreUrl, handle: product?.handle, shopDomain: shop?.domain, variantGid });
  if (!to || !title || !link) return null;

  const variant = clean(product.variantTitle, 100);
  const name = variant && variant.toLowerCase() !== "default title" ? `${title} (${variant})` : title;
  const fill = (template) => String(template).replace(/\{\{\s*product\s*\}\}/gi, name);

  const subject = clean(settings?.emailSubject ? fill(settings.emailSubject) : `${name} is back in stock`, 150) || `${title} is back in stock`;
  const intro = settings?.emailBody ? clean(fill(settings.emailBody), 1000) : `Good news! ${name} is back in stock.`;
  const button = clean(settings?.buttonLabel, 40) || "View product";
  const sender = clean(settings?.senderName, 100) || clean(shop?.name, 100) || shop?.domain || "";
  const reply = settings?.replyToEmail ? addressOf(settings.replyToEmail) : null;
  const footer = "You are receiving this email because you asked to be notified when this item was back in stock.";

  const text = `${intro}\n\n${button}: ${link}\n\n${footer}\nUnsubscribe: ${unsubscribeLink}\n`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;max-width:560px">` +
    `<p>${escapeHtml(intro)}</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#000;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(button)}</a></p>` +
    `<p style="font-size:13px;color:#666">${escapeHtml(footer)}<br><a href="${escapeHtml(unsubscribeLink)}" style="color:#666">Unsubscribe</a></p></div>`;

  return {
    messageId,
    from: sender ? { name: sender, address: mailFrom } : mailFrom,
    to,
    ...(reply ? { replyTo: reply } : {}),
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeLink}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
