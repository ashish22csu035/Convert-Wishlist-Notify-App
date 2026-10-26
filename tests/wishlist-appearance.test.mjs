// Tests for the Wishlist appearance settings: the pure rules (app/utils/wishlist-appearance-shared.js), their
// persistence (settings.server.js: getAppearance, saveAppearance, getPublicAppearance, getStorefrontFeatures) and the
// additive migration 20261023170000_wishlist_appearance.
//
// Run: node --test tests/wishlist-appearance.test.mjs
//
// The pure tests need nothing. The database tests WRITE rows, so they only run when DATABASE_URL (set in the
// environment, not just in .env) names an isolated database called kw_*test*; otherwise they are skipped and say so.
// The migration rehearsal creates and drops its own throwaway databases next to that one. Every shop row belongs to
// a uniquely named test shop that is deleted at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const shared = await import("../app/utils/wishlist-appearance-shared.js");
const {
  APPEARANCE_VERSION, DEFAULT_APPEARANCE, ICON_PATHS, MAX_APPEARANCE_BYTES, SECTIONS, SPEC,
  isAppearanceDirty, mergeAppearance, normalizeColor, normalizeStored, publicAppearance, resolveAppearance, sectionDefaults, toSparse, validateAppearance,
} = shared;

// ======================= pure rules =======================
test("defaults reproduce today's storefront: nothing set, theme fonts on, everything shown", () => {
  assert.deepEqual(DEFAULT_APPEARANCE, {
    general: { iconType: "heart", defaultColor: null, hoverColor: null, activeColor: null, useThemeFonts: true },
    productPage: { enabled: true, buttonType: "icon_text", position: "left", buttonStyle: "outline", buttonRadius: null, widthMode: "full", manualWidth: 240 },
    collectionPage: { enabled: true, iconSize: 22, backgroundOpacity: 92, position: "top-right", countDisplay: "header_badge" },
    wishlistPage: { layout: "table", headerIcon: true },
  });
  assert.equal(Object.isFrozen(DEFAULT_APPEARANCE), true);
  assert.notEqual(sectionDefaults("general"), DEFAULT_APPEARANCE.general, "a reset gets a copy it can edit");
  assert.deepEqual(SECTIONS, ["general", "productPage", "collectionPage", "wishlistPage"]);
});

test("missing, null, empty, damaged or hostile configuration resolves to the defaults", () => {
  for (const bad of [undefined, null, {}, [], "", "{", "null", 7, true, "<script>", { general: null }, { general: [] }, { general: "star" }, { version: "x" }]) {
    assert.deepEqual(resolveAppearance(bad), DEFAULT_APPEARANCE, `resolve(${JSON.stringify(bad)})`);
    assert.deepEqual(normalizeStored(bad), { version: APPEARANCE_VERSION }, `stored(${JSON.stringify(bad)})`);
  }
  assert.deepEqual(resolveAppearance({ general: { iconType: "star", defaultColor: "nope" } }).general, { ...DEFAULT_APPEARANCE.general, iconType: "star" }, "a bad value falls back on its own, the rest is kept");
});

test("enum values: only the listed options are accepted", () => {
  for (const [path, bad] of [["general.iconType", "circle"], ["general.iconType", "STAR"], ["general.iconType", ""], ["general.iconType", 1], ["productPage.buttonType", "text"], ["productPage.position", "top"], ["productPage.buttonStyle", "ghost"], ["productPage.widthMode", "wide"], ["collectionPage.position", "center"], ["collectionPage.countDisplay", "product"], ["wishlistPage.layout", "list"], ["wishlistPage.layout", ["grid"]], ["wishlistPage.layout", { toString: "grid" }]]) {
    const [section, key] = path.split(".");
    const { errors, values } = validateAppearance({ [section]: { [key]: bad } });
    assert.deepEqual(Object.keys(errors), [path], `${path} = ${JSON.stringify(bad)} is refused`);
    assert.deepEqual(values, {}, "and nothing from it is kept");
  }
  for (const [path, good] of [["general.iconType", "bookmark"], ["productPage.position", "center"], ["collectionPage.position", "bottom-left"], ["wishlistPage.layout", "grid"]]) {
    const [section, key] = path.split(".");
    assert.deepEqual(validateAppearance({ [section]: { [key]: good } }), { values: { [section]: { [key]: good } }, errors: {} });
  }
});

test("booleans must be real booleans: a string or a number never reads as on or off", () => {
  for (const bad of ["true", "false", "on", 1, 0, null, undefined, "yes"]) {
    assert.deepEqual(Object.keys(validateAppearance({ general: { useThemeFonts: bad } }).errors), ["general.useThemeFonts"], String(bad));
  }
  assert.deepEqual(validateAppearance({ productPage: { enabled: false } }).values, { productPage: { enabled: false } });
});

test("colours: only #rgb or #rrggbb, normalized to lower-case #rrggbb; empty means 'not set'", () => {
  assert.equal(normalizeColor("#ABC"), "#aabbcc");
  assert.equal(normalizeColor("  #D6336C "), "#d6336c");
  for (const bad of ["red", "#12", "#12345", "#1234567", "#gggggg", "d6336c", "rgb(1,2,3)", "url(x)", "#fff;color:red", "#fff}", "javascript:1", "var(--x)", "#ffffff80", null, 5, {}, []]) {
    assert.equal(normalizeColor(bad), null, JSON.stringify(bad));
    if (bad !== null) assert.ok(validateAppearance({ general: { defaultColor: bad } }).errors["general.defaultColor"] || bad === "", `${JSON.stringify(bad)} is refused`);
  }
  for (const empty of [null, "", "   "]) assert.deepEqual(validateAppearance({ general: { hoverColor: empty } }), { values: { general: { hoverColor: null } }, errors: {} });
  assert.deepEqual(validateAppearance({ general: { activeColor: "#ABC" } }).values, { general: { activeColor: "#aabbcc" } });
});

test("numbers: whole numbers inside their range only; limits are inclusive", () => {
  const cases = [
    ["collectionPage.iconSize", SPEC.collectionPage.iconSize.min, SPEC.collectionPage.iconSize.max],
    ["collectionPage.backgroundOpacity", 0, 100],
    ["productPage.manualWidth", 100, 800],
    ["productPage.buttonRadius", 0, 50],
  ];
  for (const [path, min, max] of cases) {
    const [section, key] = path.split(".");
    const check = (value) => validateAppearance({ [section]: { [key]: value } });
    for (const ok of [min, max, String(min), ` ${max} `]) assert.deepEqual(check(ok).errors, {}, `${path} accepts ${ok}`);
    for (const bad of [min - 1, max + 1, 1.5, "1.5", "1e2", "-1", -1, NaN, Infinity, "abc", [], {}, true, "0x10", "9".repeat(12)]) {
      if (bad === "" ) continue;
      assert.deepEqual(Object.keys(check(bad).errors), [path], `${path} refuses ${JSON.stringify(bad)}`);
    }
  }
  assert.deepEqual(validateAppearance({ productPage: { buttonRadius: "" } }), { values: { productPage: { buttonRadius: null } }, errors: {} }, "radius may be empty = follow the theme");
  assert.deepEqual(Object.keys(validateAppearance({ productPage: { manualWidth: "" } }).errors), ["productPage.manualWidth"], "width may not be empty");
  assert.deepEqual(Object.keys(validateAppearance({ collectionPage: { iconSize: null } }).errors), ["collectionPage.iconSize"]);
});

test("the icon button is never below a 44px touch target: the smallest allowed icon still gives 44px", () => {
  const min = SPEC.collectionPage.iconSize.min;
  assert.ok(Math.max(44, min + 22) === 44 && SPEC.collectionPage.iconSize.max + 22 >= 44);
  const css = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist.css", "utf8");
  assert.match(css, /width: max\(44px, calc\(var\(--kw-collection-page-icon-size, 22\) \* 1px \+ 22px\)\)/);
});

test("oversized, malformed and non-object input is refused as a whole", () => {
  const huge = JSON.stringify({ general: { iconType: "star" }, pad: "x".repeat(MAX_APPEARANCE_BYTES) });
  assert.deepEqual(Object.keys(validateAppearance(huge).errors), ["appearance"]);
  const multibyte = JSON.stringify({ general: { iconType: "star" }, pad: "€".repeat(MAX_APPEARANCE_BYTES / 2) });
  assert.ok(multibyte.length < MAX_APPEARANCE_BYTES && new TextEncoder().encode(multibyte).length > MAX_APPEARANCE_BYTES);
  assert.deepEqual(Object.keys(validateAppearance(multibyte).errors), ["appearance"], "the limit is in bytes, not characters");
  for (const bad of ["{", "not json", "[]", "7", "null", "", [], 5, null, undefined, true]) {
    assert.deepEqual(Object.keys(validateAppearance(bad).errors), ["appearance"], JSON.stringify(bad));
  }
  assert.deepEqual(Object.keys(validateAppearance({ general: "star" }).errors), ["general"], "a section must be an object");
  assert.deepEqual(validateAppearance(JSON.stringify({ general: { iconType: "star" } })), { values: { general: { iconType: "star" } }, errors: {} }, "JSON text is accepted");
});

test("unknown sections and keys are ignored, and prototype tricks change nothing", () => {
  const text = '{"__proto__":{"polluted":true},"general":{"iconType":"star","__proto__":{"x":1},"constructor":"y","shopId":"s1"},"shopId":"other","productPage":{"enabled":false,"onclick":"alert(1)"}}';
  const { values, errors } = validateAppearance(text);
  assert.deepEqual(errors, {});
  assert.deepEqual(values, { general: { iconType: "star" }, productPage: { enabled: false } });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(values.general), Object.prototype);
  assert.deepEqual(toSparse(JSON.parse(text)), { version: 1, general: { iconType: "star" }, productPage: { enabled: false } });
});

test("sparse documents keep only explicit changes; defaults spelled out are dropped; key order is stable", () => {
  assert.deepEqual(toSparse(DEFAULT_APPEARANCE), { version: 1 });
  assert.deepEqual(toSparse({}), { version: 1 });
  const edited = resolveAppearance({ general: { iconType: "star", defaultColor: "#ABC" }, collectionPage: { iconSize: 30 } });
  assert.deepEqual(toSparse(edited), { version: 1, general: { iconType: "star", defaultColor: "#aabbcc" }, collectionPage: { iconSize: 30 } });
  assert.equal(JSON.stringify(toSparse({ collectionPage: { iconSize: 30 }, general: { defaultColor: "#abc", iconType: "star" } })), JSON.stringify(toSparse(edited)), "same content, same text, whatever the input order");
  assert.deepEqual(toSparse({ general: { iconType: "heart", defaultColor: null, useThemeFonts: true } }), { version: 1 }, "explicit defaults are not stored");
  assert.deepEqual(resolveAppearance(toSparse(edited)), edited, "sparse -> resolved round-trips");
  assert.deepEqual(publicAppearance(edited), toSparse(edited), "the storefront gets exactly the sparse form");
});

test("a colour is only an override once the merchant sets it: unset stays null so the theme editor colour keeps working", () => {
  assert.equal(DEFAULT_APPEARANCE.general.defaultColor, null);
  assert.equal("defaultColor" in (toSparse(resolveAppearance({ general: { iconType: "star" } })).general ?? {}), false, "changing something else never fixes a colour");
  assert.equal(toSparse({ general: { defaultColor: "#d6336c" } }).general.defaultColor, "#d6336c", "choosing the old default colour explicitly IS an override");
});

test("merging keeps keys the update does not mention; setting a key back to its default removes it", () => {
  const saved = toSparse({ general: { iconType: "bookmark" }, productPage: { enabled: false } });
  const merged = mergeAppearance(saved, { collectionPage: { iconSize: 30 } });
  assert.deepEqual(toSparse(merged), { version: 1, general: { iconType: "bookmark" }, productPage: { enabled: false }, collectionPage: { iconSize: 30 } });
  assert.deepEqual(toSparse(mergeAppearance(merged, { general: { iconType: "heart" } })), { version: 1, productPage: { enabled: false }, collectionPage: { iconSize: 30 } });
  assert.deepEqual(saved, { version: 1, general: { iconType: "bookmark" }, productPage: { enabled: false } }, "the saved copy is not changed in place");
});

test("dirty state compares what would be stored, not how it is spelled", () => {
  const saved = resolveAppearance({ general: { iconType: "star" } });
  assert.equal(isAppearanceDirty(saved, saved), false);
  assert.equal(isAppearanceDirty(saved, toSparse(saved)), false, "resolved vs sparse of the same settings");
  assert.equal(isAppearanceDirty({ ...saved, general: { ...saved.general, defaultColor: "#ABC" } }, saved), true);
  assert.equal(isAppearanceDirty({ ...saved, general: { ...saved.general, defaultColor: "#aabbcc" } }, { ...saved, general: { ...saved.general, defaultColor: "#ABC" } }), false, "#ABC and #aabbcc are the same colour");
  assert.equal(isAppearanceDirty({ ...saved, general: { ...saved.general, iconType: "heart" } }, saved), true);
  assert.equal(isAppearanceDirty(DEFAULT_APPEARANCE, null), false, "nothing saved = defaults");
});

test("the preview and the storefront draw the same three icons", () => {
  const script = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist.js", "utf8");
  for (const [name, path] of Object.entries(ICON_PATHS)) assert.ok(script.includes(`class="kw-i-${name}" d="${path}"`), `${name} path is identical in konvert-wishlist.js`);
});

// ======================= database =======================
const dbUrl = process.env.DATABASE_URL ?? "";
const dbName = (() => {
  try {
    return new URL(dbUrl).pathname.slice(1);
  } catch {
    return "";
  }
})();
const ISOLATED = /^kw_.*test/i.test(dbName);
const skip = ISOLATED ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const dbTest = (name, fn) => test(name, { skip }, fn);

const RUN = Date.now().toString(36);
const domains = [];
const newDomain = (tag) => {
  const domain = `kw-appearance-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return domain;
};
let prisma;
let settings;
const throwaway = [];
let admin;

before(async () => {
  if (!ISOLATED) return;
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  prisma = new PrismaClient();
  settings = await import("../app/models/settings.server.js");
});

after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
    (await import("../app/db.server.js")).default.$disconnect();
  }
  for (const name of throwaway) await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin?.$disconnect();
});

const rowOf = (domain) => prisma.shopSettings.findFirst({ where: { shop: { domain } } });
const stored = async (domain) => (await rowOf(domain))?.wishlistAppearance;

dbTest("a shop with no settings row: today's look, both features on, and reading creates nothing", async () => {
  const domain = newDomain("none");
  assert.deepEqual(await settings.getAppearance(domain), DEFAULT_APPEARANCE);
  assert.deepEqual(await settings.getPublicAppearance(domain), { version: 1 });
  assert.deepEqual(await settings.getStorefrontFeatures(domain), { wishlist: true, notifyMe: true, appearance: { version: 1 } });
  assert.deepEqual(await settings.getFeatureFlags(domain), { wishlist: true, notifyMe: true }, "the existing flags function is unchanged");
  assert.equal(await prisma.shop.count({ where: { domain } }), 0, "nothing was created by reading");
});

dbTest("saving creates the shop row when needed, stores only the changes, and leaves the switches on", async () => {
  const domain = newDomain("create");
  const input = resolveAppearance({ general: { iconType: "star", defaultColor: "#ABC" }, collectionPage: { position: "bottom-left" } });
  const result = await settings.saveAppearance(domain, JSON.stringify(input));
  assert.equal(result.ok, true);
  assert.deepEqual(result.appearance, input, "the answer is the complete saved appearance");
  assert.deepEqual(await stored(domain), { version: 1, general: { iconType: "star", defaultColor: "#aabbcc" }, collectionPage: { position: "bottom-left" } }, "only explicit changes are stored, colour normalized");
  const row = await rowOf(domain);
  assert.deepEqual([row.wishlistEnabled, row.notifyMeEnabled], [true, true]);
  assert.deepEqual(await settings.getAppearance(domain), input);
  const features = await settings.getStorefrontFeatures(domain);
  assert.deepEqual(features, { wishlist: true, notifyMe: true, appearance: await stored(domain) });
});

dbTest("saving all defaults stores just the version; the store looks as before", async () => {
  const domain = newDomain("defaults");
  await settings.saveAppearance(domain, JSON.stringify(resolveAppearance({ general: { iconType: "star" } })));
  const result = await settings.saveAppearance(domain, JSON.stringify(DEFAULT_APPEARANCE));
  assert.equal(result.ok, true);
  assert.deepEqual(await stored(domain), { version: 1 });
  assert.deepEqual(await settings.getAppearance(domain), DEFAULT_APPEARANCE);
});

dbTest("partial updates keep the saved keys they do not mention; a key set back to its default disappears", async () => {
  const domain = newDomain("partial");
  await settings.saveAppearance(domain, { general: { iconType: "bookmark" } });
  await settings.saveAppearance(domain, { productPage: { enabled: false, buttonRadius: 12 } });
  assert.deepEqual(await stored(domain), { version: 1, general: { iconType: "bookmark" }, productPage: { enabled: false, buttonRadius: 12 } });
  await settings.saveAppearance(domain, { general: { iconType: "heart" }, productPage: { buttonRadius: null } });
  assert.deepEqual(await stored(domain), { version: 1, productPage: { enabled: false } });
});

dbTest("invalid input is refused, reports which fields, and writes nothing (not even a shop row)", async () => {
  const fresh = newDomain("invalid-new");
  const bad = await settings.saveAppearance(fresh, { general: { iconType: "circle", defaultColor: "red" }, collectionPage: { iconSize: 5 } });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["collectionPage.iconSize", "general.defaultColor", "general.iconType"]);
  assert.equal(await prisma.shop.count({ where: { domain: fresh } }), 0);

  const domain = newDomain("invalid-old");
  await settings.saveAppearance(domain, { general: { iconType: "star" } });
  const before = await stored(domain);
  for (const input of [{ general: { iconType: "nope" } }, "{", "x".repeat(MAX_APPEARANCE_BYTES + 1), { productPage: { buttonRadius: 51 } }]) {
    assert.equal((await settings.saveAppearance(domain, input)).ok, false);
  }
  assert.deepEqual(await stored(domain), before, "the saved appearance is untouched by every refused save");
  // a valid key next to an invalid one saves neither
  assert.equal((await settings.saveAppearance(domain, { general: { iconType: "bookmark" }, collectionPage: { iconSize: 1 } })).ok, false);
  assert.deepEqual(await stored(domain), before);
});

dbTest("each shop has its own appearance: saving, reading and the storefront answer never cross shops", async () => {
  const a = newDomain("iso-a");
  const b = newDomain("iso-b");
  const c = newDomain("iso-c");
  await settings.saveAppearance(a, { general: { iconType: "star" }, wishlistPage: { layout: "grid" } });
  await settings.saveAppearance(b, { general: { iconType: "bookmark" } });
  assert.deepEqual(await settings.getPublicAppearance(a), { version: 1, general: { iconType: "star" }, wishlistPage: { layout: "grid" } });
  assert.deepEqual(await settings.getPublicAppearance(b), { version: 1, general: { iconType: "bookmark" } });
  assert.deepEqual(await settings.getPublicAppearance(c), { version: 1 }, "a shop that never saved anything");
  await settings.saveAppearance(b, { general: { iconType: "heart" } });
  assert.deepEqual((await settings.getStorefrontFeatures(a)).appearance, { version: 1, general: { iconType: "star" }, wishlistPage: { layout: "grid" } }, "saving for b did not touch a");
  assert.equal((await settings.getAppearance(a)).general.iconType, "star");
  assert.equal((await settings.getAppearance(b)).general.iconType, "heart");
});

dbTest("saving appearance never changes the switches or any email field, and saving the switches never changes the appearance", async () => {
  const domain = newDomain("independent");
  const shop = await prisma.shop.create({ data: { domain, currencyCode: "XXX" } });
  const email = { senderName: "Hat Shop", replyToEmail: "help@hat.example", emailSubject: "Back: {{product}}", emailBody: "It is here.", buttonLabel: "Grab it", activityRetentionDays: 90 };
  await prisma.shopSettings.create({ data: { shopId: shop.id, wishlistEnabled: false, notifyMeEnabled: false, ...email } });
  const snapshot = async () => {
    const { id, shopId, wishlistEnabled, notifyMeEnabled, senderName, replyToEmail, emailSubject, emailBody, buttonLabel, activityRetentionDays } = await rowOf(domain);
    return { id, shopId, wishlistEnabled, notifyMeEnabled, senderName, replyToEmail, emailSubject, emailBody, buttonLabel, activityRetentionDays };
  };
  const original = await snapshot();

  assert.equal((await settings.saveAppearance(domain, { general: { iconType: "star" }, productPage: { enabled: false } })).ok, true);
  assert.deepEqual(await snapshot(), original, "switches, email fields, ids: all unchanged by an appearance save");
  assert.deepEqual(await settings.getFeatureFlags(domain), { wishlist: false, notifyMe: false });
  assert.deepEqual(await settings.getStorefrontFeatures(domain), { wishlist: false, notifyMe: false, appearance: { version: 1, general: { iconType: "star" }, productPage: { enabled: false } } }, "both switches stay off while an appearance exists");

  const switches = settings.validateSettings({ wishlistEnabled: "true", notifyMeEnabled: "false" });
  assert.deepEqual(switches.errors, {});
  await settings.saveSettings(domain, switches.values);
  assert.deepEqual(await stored(domain), { version: 1, general: { iconType: "star" }, productPage: { enabled: false } }, "a switch save leaves the appearance as it was");
  assert.deepEqual(await snapshot(), { ...original, wishlistEnabled: true, notifyMeEnabled: false }, "and changes only the two switches");
  // the old validator still insists on both switches, and knows nothing of appearance
  assert.deepEqual(Object.keys(settings.validateSettings({ wishlistEnabled: "true" }).errors), ["notifyMeEnabled"]);
  assert.deepEqual(Object.keys(settings.validateSettings({ general: { iconType: "star" } }).errors).sort(), ["notifyMeEnabled", "wishlistEnabled"]);
});

dbTest("a shop whose switches were saved before any appearance existed (column NULL) keeps its look and its switches", async () => {
  const domain = newDomain("legacy");
  await settings.saveSettings(domain, { wishlistEnabled: false, notifyMeEnabled: true });
  assert.equal((await rowOf(domain)).wishlistAppearance, null, "an old-style row has NULL");
  assert.deepEqual(await settings.getAppearance(domain), DEFAULT_APPEARANCE);
  assert.deepEqual(validateAppearance(await settings.getAppearance(domain)).errors, {}, "the Wishlist Settings screen starts from a valid state, so Save is never blocked by a NULL column");
  assert.deepEqual(await settings.getStorefrontFeatures(domain), { wishlist: false, notifyMe: true, appearance: { version: 1 } });
});

dbTest("a damaged stored document never breaks the screen or the storefront; the switches are still answered", async () => {
  const domain = newDomain("damaged");
  await settings.saveSettings(domain, { wishlistEnabled: false, notifyMeEnabled: true });
  const hostile = [
    "just text", ["general"], 42, true, { general: "star" }, { general: { iconType: { $gt: "" }, defaultColor: ["#fff"], useThemeFonts: "false" } },
    { version: 99, general: { iconType: "star", defaultColor: "expression(alert(1))" }, collectionPage: { iconSize: 1e9, position: "middle" } },
  ];
  for (const doc of hostile) {
    await prisma.shopSettings.updateMany({ where: { shop: { domain } }, data: { wishlistAppearance: doc } });
    const resolved = await settings.getAppearance(domain);
    const features = await settings.getStorefrontFeatures(domain);
    assert.equal(features.wishlist, false);
    assert.equal(features.notifyMe, true);
    assert.deepEqual(resolved, resolveAppearance(doc), JSON.stringify(doc));
    assert.deepEqual(features.appearance, toSparse(doc));
    assert.equal(features.appearance.version, 1);
    for (const value of Object.values(features.appearance).flatMap((part) => (typeof part === "object" ? Object.values(part) : []))) {
      assert.match(String(value), /^(?:[a-z_-]{1,16}|#[0-9a-f]{6}|\d{1,3}|true|false)$/, "only plain words, numbers and hex colours reach the storefront");
    }
  }
  assert.deepEqual((await settings.getStorefrontFeatures(domain)).appearance, { version: 1, general: { iconType: "star" } }, "from the last document only the valid, plain value survives");
});

// ======================= migration rehearsal =======================
const migrationDirs = () => fs.readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort();
function statements(file) {
  const text = fs.readFileSync(file, "utf8").split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  return text.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}
const applyMigration = async (client, dir) => {
  for (const statement of statements(`prisma/migrations/${dir}/migration.sql`)) await client.$executeRawUnsafe(statement);
};
// Ends a child process by closing the database connection, so its output is fully written first.
const END = 'await (await import("./app/db.server.js")).default.$disconnect();';
const runApp = (url, code) =>
  JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", `import "./tests/helpers/resolve-extensionless.mjs";\n${code}`], {
      env: { ...process.env, DATABASE_URL: url, SHOPIFY_API_KEY: "dummy-key", SHOPIFY_API_SECRET: "dummy-secret-for-tests-only", SHOPIFY_APP_URL: "http://localhost:1", SCOPES: "write_products" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n").at(-1),
  );

dbTest("migration: additive and nullable; existing shops, settings, ids and constraints survive; the app copes before and after", async () => {
  const dirs = migrationDirs();
  const last = dirs.at(-1);
  assert.equal(last, "20261023170000_wishlist_appearance", "it is the newest migration, applied after all earlier ones");
  assert.equal(dirs.length, 7);
  assert.match(fs.readFileSync(`prisma/migrations/${last}/migration.sql`, "utf8").replace(/--.*\n/g, "").trim(), /^ALTER TABLE `ShopSettings` ADD COLUMN `wishlistAppearance` JSON NULL;$/, "exactly one statement, no data change");

  admin = new PrismaClient();
  const name = `${dbName}_mig_${RUN}`.slice(0, 60);
  throwaway.push(name);
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\``);
  const url = dbUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const scratch = new PrismaClient({ datasources: { db: { url } } });
  try {
    for (const dir of dirs.slice(0, -1)) await applyMigration(scratch, dir);

    // Existing data, written the way the app wrote it before this migration.
    const shopId = "11111111-2222-4333-8444-555555555555";
    const otherId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    await scratch.$executeRawUnsafe("INSERT INTO Shop (id, domain, currencyCode, updatedAt) VALUES (?, 'old-a.myshopify.com', 'USD', NOW(3)), (?, 'old-b.myshopify.com', 'EUR', NOW(3))", shopId, otherId);
    await scratch.$executeRawUnsafe("INSERT INTO ShopSettings (id, shopId, wishlistEnabled, notifyMeEnabled, senderName, replyToEmail, emailSubject, emailBody, buttonLabel, activityRetentionDays, updatedAt) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', ?, 0, 1, 'Hat Shop', 'help@hat.example', 'Back', 'Body', 'Grab it', 90, NOW(3))", shopId);
    await scratch.$executeRawUnsafe("INSERT INTO Actor (id, shopId, customerGid) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', ?, 'gid://shopify/Customer/1')", shopId);
    await scratch.$executeRawUnsafe("INSERT INTO WishlistItem (id, shopId, actorId, productGid, variantGid, productTitle, productHandle) VALUES ('cccccccc-0000-4000-8000-000000000001', ?, 'bbbbbbbb-0000-4000-8000-000000000001', 'gid://shopify/Product/1', 'gid://shopify/ProductVariant/1', 'Hat', 'hat')", shopId);
    const fingerprint = async () => ({
      settings: await scratch.$queryRawUnsafe("SELECT id, shopId, wishlistEnabled, notifyMeEnabled, senderName, replyToEmail, emailSubject, emailBody, buttonLabel, activityRetentionDays FROM ShopSettings ORDER BY id"),
      shops: await scratch.$queryRawUnsafe("SELECT id, domain, currencyCode FROM Shop ORDER BY id"),
      items: await scratch.$queryRawUnsafe("SELECT id, shopId, actorId, variantGid FROM WishlistItem"),
      constraints: await scratch.$queryRawUnsafe("SELECT TABLE_NAME t, CONSTRAINT_NAME c, CONSTRAINT_TYPE k FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() ORDER BY 1, 2"),
      keys: await scratch.$queryRawUnsafe("SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE y, IS_NULLABLE n, COLUMN_KEY k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> 'ShopSettings' ORDER BY 1, 2"),
      settingsColumns: await scratch.$queryRawUnsafe("SELECT COLUMN_NAME c, COLUMN_TYPE y, IS_NULLABLE n, COLUMN_KEY k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ShopSettings' AND COLUMN_NAME <> 'wishlistAppearance' ORDER BY 1"),
    });
    const toPlain = (rows) => JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === "bigint" ? Number(v) : v)));
    const before = toPlain(await fingerprint());

    // New code, old schema (deployed before the migration is applied): the switches are still answered.
    const early = runApp(url, `const m = await import("./app/models/settings.server.js"); console.log(JSON.stringify(await m.getStorefrontFeatures("old-a.myshopify.com"))); ${END}`);
    assert.deepEqual(early, { wishlist: false, notifyMe: true, appearance: { version: 1 } }, "the switch the merchant set still applies, the look is today's");

    await applyMigration(scratch, last);

    const after = toPlain(await fingerprint());
    assert.deepEqual(after, before, "no row, id, key, constraint or other column changed");
    const column = await scratch.$queryRawUnsafe("SELECT COLUMN_TYPE y, IS_NULLABLE n, COLUMN_DEFAULT d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ShopSettings' AND COLUMN_NAME = 'wishlistAppearance'");
    assert.deepEqual(toPlain(column), [{ y: "json", n: "YES", d: null }]);
    assert.deepEqual(toPlain(await scratch.$queryRawUnsafe("SELECT COUNT(*) n FROM ShopSettings WHERE wishlistAppearance IS NOT NULL")), [{ n: 0 }], "every existing row is NULL = unchanged look");

    const late = runApp(url, `const m = await import("./app/models/settings.server.js"); console.log(JSON.stringify([await m.getStorefrontFeatures("old-a.myshopify.com"), await m.getStorefrontFeatures("old-b.myshopify.com"), await m.getAppearance("old-b.myshopify.com")])); ${END}`);
    assert.deepEqual(late[0], { wishlist: false, notifyMe: true, appearance: { version: 1 } });
    assert.deepEqual(late[1], { wishlist: true, notifyMe: true, appearance: { version: 1 } }, "a shop that had no settings row at all");
    assert.deepEqual(late[2], DEFAULT_APPEARANCE);

    const saved = runApp(url, `const m = await import("./app/models/settings.server.js"); const r = await m.saveAppearance("old-a.myshopify.com", { general: { iconType: "star" } }); console.log(JSON.stringify([r.ok, await m.getStorefrontFeatures("old-a.myshopify.com")])); ${END}`);
    assert.deepEqual(saved, [true, { wishlist: false, notifyMe: true, appearance: { version: 1, general: { iconType: "star" } } }]);
    const row = toPlain(await scratch.$queryRawUnsafe("SELECT wishlistEnabled, notifyMeEnabled, senderName, activityRetentionDays FROM ShopSettings WHERE shopId = ?", shopId));
    assert.deepEqual(row, [{ wishlistEnabled: 0, notifyMeEnabled: 1, senderName: "Hat Shop", activityRetentionDays: 90 }], "saving the appearance on the migrated row left the rest alone");
  } finally {
    await scratch.$disconnect();
  }
});
