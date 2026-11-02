import prisma from "../db.server";
import { maskEmail } from "../utils/mask-email";

// Masked customer emails for the merchant screens, so a table can show "a*****@gmail.com" instead of "Customer 123".
//
//   - One Admin API request per 100 customers (nodes(ids:)), for the customers on the page being drawn - never one per row.
//     It reads the same field the restock sender uses (customer.defaultEmailAddress), with the shop's own authenticated admin.
//   - Where Shopify gives no email (read_customers / protected customer data not granted, customer deleted, no email, a
//     failed request), the email the customer typed for a Notify Me subscription is used if the database has one; this is
//     one grouped read for the whole page.
//   - Masking happens HERE, so a full address never leaves the server and never reaches a page's data.
//   - Nothing is stored. A customer with no usable email is simply missing from the result, and the screen keeps showing
//     "Customer <id>"; an address is never invented.
// Returns { [numericCustomerId]: "a*****@domain" }.

const CUSTOMER_EMAILS_QUERY = `#graphql
  query KonvertCustomerEmails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer {
        id
        defaultEmailAddress { emailAddress }
      }
    }
  }
`;

const CHUNK = 100;
const gidOf = (customerId) => `gid://shopify/Customer/${customerId}`;
const idOf = (gid) => String(gid).split("/").pop();

async function emailsFromShopify(admin, ids) {
  const found = {};
  if (!admin) return found;
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const response = await admin.graphql(CUSTOMER_EMAILS_QUERY, { variables: { ids: ids.slice(i, i + CHUNK).map(gidOf) } });
      const json = await response.json();
      for (const node of json?.data?.nodes ?? []) {
        const masked = maskEmail(node?.defaultEmailAddress?.emailAddress);
        if (node?.id && masked) found[idOf(node.id)] = masked;
      }
    }
  } catch {
    /* Shopify unreachable or the data is not available to this app: the database fallback below covers what it can */
  }
  return found;
}

async function emailsFromSubscriptions(shopId, ids) {
  if (ids.length === 0) return {};
  const rows = await prisma.notifySubscription.findMany({
    where: { shopId, actor: { customerGid: { in: ids.map(gidOf) } } },
    select: { email: true, actor: { select: { customerGid: true } } },
    orderBy: { createdAt: "desc" }, // newest first, so the most recent address wins
  });
  const found = {};
  for (const row of rows) {
    const id = idOf(row.actor.customerGid);
    const masked = maskEmail(row.email);
    if (masked && !(id in found)) found[id] = masked;
  }
  return found;
}

export async function maskedCustomerEmails(admin, shopId, customerIds) {
  const ids = [...new Set((customerIds ?? []).map(String).filter((id) => /^\d+$/.test(id)))].slice(0, 500);
  if (!shopId || ids.length === 0) return {};
  const fromShopify = await emailsFromShopify(admin, ids);
  const missing = ids.filter((id) => !(id in fromShopify));
  let fallback = {};
  try {
    fallback = await emailsFromSubscriptions(shopId, missing);
  } catch {
    fallback = {};
  }
  return { ...fallback, ...fromShopify };
}
