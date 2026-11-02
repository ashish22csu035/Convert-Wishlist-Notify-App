// Tests for the one email-masking function (app/utils/mask-email.js) and for where the merchant screens use it.
// Pure: no database. Run: node --test tests/mask-email.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { maskEmail } from "../app/utils/mask-email.js";

test("the first character stays, the rest of the local part becomes asterisks, the domain stays whole", () => {
  assert.equal(maskEmail("ashishmehta425@gmail.com"), "a*************@gmail.com");
  assert.equal(maskEmail("john@example.com"), "j***@example.com");
  assert.equal(maskEmail("alex@company.in"), "a***@company.in");
  assert.equal(maskEmail("Maria.Lopez+shop@mail.co.uk"), `M${"*".repeat(15)}@mail.co.uk`, "dots, plus tags, capitals and long domains are handled; the local part keeps its length");
});

test("short local parts never show more than they should", () => {
  assert.equal(maskEmail("ab@x.io"), "a*@x.io");
  assert.equal(maskEmail("a@x.io"), "*@x.io", "a one-character name would be shown whole, so it is hidden");
});

test("surrounding spaces are ignored; the masked text keeps the same length as the local part", () => {
  assert.equal(maskEmail("  john@example.com  "), "j***@example.com");
  assert.equal(maskEmail("émile@example.fr"), "é****@example.fr", "by character, not by byte");
});

test("missing or invalid values give null, never a made-up address", () => {
  for (const bad of [null, undefined, "", "   ", 42, {}, [], "plainstring", "@example.com", "john@", "john@example", "john@.com", "jo hn@example.com", "john@exa mple.com"]) {
    assert.equal(maskEmail(bad), null, JSON.stringify(bad));
  }
});

test("a masked address never contains the hidden part of the original", () => {
  const masked = maskEmail("ashishmehta425@gmail.com");
  assert.equal(masked.includes("shishmehta"), false);
  assert.equal(masked.includes("425"), false);
});

test("every customer table masks through the same function and component; no page formats a customer on its own", () => {
  for (const file of ["app.wishlist", "app.customers", "app.analytics"]) {
    const source = fs.readFileSync(`app/routes/${file}.jsx`, "utf8");
    assert.match(source, /<CustomerLink customerId=\{[a-z.]*customerId\} emails=\{/, `${file} uses the shared CustomerLink`);
    assert.equal(/Customer \{(row|customer)\.customerId\}/.test(source), false, `${file} no longer prints the bare id`);
    assert.equal(/shopify:\/\/admin\/customers/.test(source), false, `${file} leaves the link to CustomerLink`);
    assert.match(source, /maskedCustomerEmails\(admin, shop\.id,/, `${file} asks once for the whole page`);
  }
  const ui = fs.readFileSync("app/components/merchant-ui.jsx", "utf8");
  const link = ui.slice(ui.indexOf("export function CustomerLink"), ui.indexOf("export function Tabs"));
  assert.match(link, /href=\{`shopify:\/\/admin\/customers\/\$\{customerId\}`\}/, "the link goes to the customer by their id, whatever text it shows");
  assert.equal(/maskEmail|emailAddress/.test(link), false, "CustomerLink only shows what it is given");
  const lib = fs.readFileSync("app/models/customer-emails.server.js", "utf8");
  assert.match(lib, /import \{ maskEmail \} from "\.\.\/utils\/mask-email"/);
  // masking happens before anything is returned to a route, so a full address cannot reach the page
  assert.equal(/found\[[^\]]+\] = (node|row)\.[a-zA-Z.?]*email/i.test(lib), false);
});
