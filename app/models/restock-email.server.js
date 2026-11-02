import { addressOf } from "./mail-config.server";
import { effectiveNotify, renderNotifyEmail } from "../utils/notify-settings-shared";

// Builds the back-in-stock email. Pure: everything comes in as arguments. Returns null when the
// required product information is missing, so nothing is ever sent with an invented title or link.

const clean = (value, max) =>
  // eslint-disable-next-line no-control-regex
  String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

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
  // The merchant's Notify Me Settings (ShopSettings.notifyMeSettings), with the older email columns as the fallback.
  // The variables come from data this flow really has; there is no customer name (only the email address is stored).
  const email = effectiveNotify(settings?.notifyMeSettings, settings).email;
  const shopName = clean(shop?.name, 100) || shop?.domain || "";
  const rendered = renderNotifyEmail(email, { product: name, product_url: link, shop_name: shopName }, unsubscribeLink, `${title} is back in stock`);
  const sender = clean(settings?.senderName, 100) || shopName;
  const reply = settings?.replyToEmail ? addressOf(settings.replyToEmail) : null;

  return {
    messageId,
    from: sender ? { name: sender, address: mailFrom } : mailFrom,
    to,
    ...(reply ? { replyTo: reply } : {}),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeLink}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
