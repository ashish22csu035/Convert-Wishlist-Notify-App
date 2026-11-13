import "./helpers/resolve-extensionless.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { limitPeriod, parsePeriod, periodView, presetPeriod, customPeriod, previousOf, previousWithinHistory, DAY_MS } = await import("../app/utils/period.js");
const { analyticsCacheKey } = await import("../app/models/analytics-cache.server.js");
const { getAnalyticsOverview, getAnalytics, getDashboard } = await import("../app/models/reporting.server.js");
const { createRequire } = await import("node:module");
const { PrismaClient } = createRequire(import.meta.url)("@prisma/client");
const { PLANS } = await import("../app/models/plans.server.js");
const { analyticsHistoryDays, clampHistoryDays } = await import("../app/models/entitlements.server.js");

// Analytics history by plan (Basic 7, Advance 30, Enterprise 90 days), applied to the merchant's date range on the server.
const NOW = new Date("2026-11-12T10:00:00Z");
const ent = (key) => ({ plan: PLANS[key] });
const max = (key) => analyticsHistoryDays(ent(key));

test("the plan limits are 7, 30 and 90 days", () => {
  assert.deepEqual(["BASIC", "ADVANCE", "ENTERPRISE"].map(max), [7, 30, 90]);
  assert.equal(clampHistoryDays(90, ent("BASIC")), 7);
});

test("presets: a longer request is shortened to the plan's window, a shorter one is untouched", () => {
  const ninety = presetPeriod(90, NOW);
  assert.equal(limitPeriod(ninety, 7, NOW).days, 7);
  assert.equal(limitPeriod(ninety, 7, NOW).limited, true);
  assert.equal(limitPeriod(ninety, 30, NOW).days, 30);
  const full = limitPeriod(ninety, 90, NOW);
  assert.equal(full.days, 90);
  assert.equal(full.limited, undefined);
  const seven = limitPeriod(presetPeriod(7, NOW), 30, NOW);
  assert.equal(seven.days, 7);
  assert.equal(seven.limited, undefined);
});

test("the default 30-day preset becomes 7 days on Basic, so a plain /app/analytics URL cannot read past the plan", () => {
  const limited = limitPeriod(parsePeriod({}, NOW), max("BASIC"), NOW);
  assert.equal(limited.days, 7);
  assert.equal(limited.since.toISOString(), "2026-11-06T00:00:00.000Z");
});

test("custom ranges: the start moves up to the window's first day (counted back from today), the end stays", () => {
  const { period } = customPeriod("2026-08-01", "2026-11-10", NOW);
  const limited = limitPeriod(period, 7, NOW);
  assert.equal(limited.limited, true);
  assert.equal(limited.days, 5); // 6 Nov (the 7-day window starts here) .. 10 Nov
  assert.equal(limited.to, "2026-11-10");
  assert.equal(limited.from, "2026-11-06");
  assert.equal(limited.until.getTime() - limited.since.getTime(), 5 * DAY_MS);
});

test("a custom range entirely older than the window shows the window's own newest days, never older data", () => {
  const { period } = customPeriod("2026-01-01", "2026-01-31", NOW);
  const limited = limitPeriod(period, 7, NOW);
  assert.equal(limited.limited, true);
  assert.equal(limited.from, "2026-11-06");
  assert.equal(limited.to, "2026-11-12");
  assert.ok(limited.since >= new Date(NOW.getTime() - 7 * DAY_MS));
});

test("a custom range that fits is unchanged", () => {
  const { period } = customPeriod("2026-11-08", "2026-11-12", NOW);
  const limited = limitPeriod(period, 7, NOW);
  assert.equal(limited.from, "2026-11-08");
  assert.equal(limited.limited, undefined);
});

test("a missing or invalid limit changes nothing (enforcement off, or no entitlement)", () => {
  const period = presetPeriod(90, NOW);
  for (const bad of [undefined, null, 0, -5, 2.5, NaN, "7"]) assert.equal(limitPeriod(period, bad, NOW), period);
});

test("periodView carries maxDays and limited so the picker can offer only allowed presets", () => {
  const view = periodView(limitPeriod(presetPeriod(90, NOW), 7, NOW));
  assert.equal(view.maxDays, 7);
  assert.equal(view.limited, true);
  assert.equal("maxDays" in periodView(presetPeriod(30, NOW)), false, "unchanged shape while no limit applies");
});

// ======================= the comparison period respects the same history limit =======================
test("previousWithinHistory: the whole previous period must lie inside the plan's history; without a limit everything is allowed", () => {
  const at = (days, maxDays) => previousWithinHistory(limitPeriod(presetPeriod(days, NOW), maxDays, NOW), NOW);
  assert.equal(at(7, 7), false, "Basic: a 7-day view would need 14 days of history");
  assert.equal(at(7, 30), true, "Advance can compare the last 7 days with the 7 before");
  assert.equal(at(30, 30), false, "Advance: 30 vs the 30 before needs 60 days");
  assert.equal(at(30, 90), true, "Enterprise can compare 30 with the 30 before");
  assert.equal(at(90, 90), false);
  assert.equal(previousWithinHistory(presetPeriod(90, NOW), NOW), true, "no limit on the period: unchanged behaviour");
});

test("previousWithinHistory: the boundary is exact (the previous period may start on the window's first day, not a day earlier)", () => {
  const period = { ...presetPeriod(7, NOW), maxDays: 14 }; // previous starts 7 days before 6 Nov = 30 Oct; window starts 30 Oct
  assert.equal(previousOf(period).since.toISOString(), "2026-10-30T00:00:00.000Z");
  assert.equal(previousWithinHistory(period, NOW), true);
  assert.equal(previousWithinHistory({ ...period, maxDays: 13 }, NOW), false);
});

test("the Analytics cache key carries the history limit only when there is one, so a plan change never serves the other plan's report", () => {
  const free = presetPeriod(7, NOW);
  const base = analyticsCacheKey("shop", "1", free);
  assert.equal(base.endsWith(":open"), true, "an unlimited period keeps the old key");
  const basic = analyticsCacheKey("shop", "1", { ...free, maxDays: 7 });
  const advance = analyticsCacheKey("shop", "1", { ...free, maxDays: 30 });
  assert.equal(new Set([base, basic, advance]).size, 3);
  assert.equal(basic.endsWith(":open:h7"), true);
});

const dbName = (() => { try { return new URL(process.env.DATABASE_URL ?? "").pathname.slice(1); } catch { return ""; } })();
const skip = /^kw_.*test/i.test(dbName) ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const prisma = skip ? null : new PrismaClient();
const RUN = Date.now().toString(36);
const domains = [];
import { after } from "node:test";
after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});

test("reports offer a comparison only when the previous period is inside the plan's history (all three report loaders)", { skip }, async () => {
  const domain = `kw-alimit-${RUN}.myshopify.com`;
  domains.push(domain);
  const shop = await prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: new Date("2026-01-01T00:00:00Z") } });
  const view = async (loader, days, maxDays) => (await loader(shop, maxDays ? limitPeriod(presetPeriod(days, NOW), maxDays, NOW) : presetPeriod(days, NOW), NOW)).comparable;
  for (const [name, loader] of [["getAnalyticsOverview", getAnalyticsOverview], ["getAnalytics", getAnalytics], ["getDashboard", getDashboard]]) {
    assert.equal(await view(loader, 7, null), true, `${name}: no limit, as before`);
    assert.equal(await view(loader, 7, 7), false, `${name}: Basic 7 days`);
    assert.equal(await view(loader, 7, 30), true, `${name}: Advance 7 days`);
    assert.equal(await view(loader, 30, 30), false, `${name}: Advance 30 days`);
    assert.equal(await view(loader, 30, 90), true, `${name}: Enterprise 30 days`);
    assert.equal(await view(loader, 90, 90), false, `${name}: Enterprise 90 days`);
  }
});
