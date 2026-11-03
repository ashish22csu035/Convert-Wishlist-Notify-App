// Recalculates the stored AnalyticsDaily session totals with the current definition (every BrowsingSession, on the UTC
// day it started). See app/worker/recalculate-sessions.server.js for exactly what it reads and writes.
//
//   node scripts/recalculate-analytics-sessions.mjs                     DRY RUN (default): prints the rows that would change, writes nothing
//   node scripts/recalculate-analytics-sessions.mjs --shop <shop id>    ...for one shop
//   node scripts/recalculate-analytics-sessions.mjs --apply             writes the changes (only after checking the dry run)
//
// It uses the database in DATABASE_URL (or .env). Stop the analytics worker first (or make sure it runs the current code):
// a worker still on the old definition rewrites today and the last few days with the old numbers on every run.
import { register } from "node:module";

register("./resolve-hooks.mjs", import.meta.url);

if (!process.env.WORKER_SKIP_DOTENV) {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file: the environment alone is used */
  }
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const shopFlag = args.indexOf("--shop");
const shopIds = shopFlag >= 0 && args[shopFlag + 1] ? [args[shopFlag + 1]] : undefined;
const unknown = args.filter((arg, i) => !["--apply", "--shop"].includes(arg) && args[i - 1] !== "--shop");
if (unknown.length || (shopFlag >= 0 && !shopIds)) {
  console.error("Usage: node scripts/recalculate-analytics-sessions.mjs [--shop <shop id>] [--apply]");
  process.exit(1);
}

const { recalculateSessionTotals } = await import("../app/worker/recalculate-sessions.server.js");
const prisma = (await import("../app/db.server.js")).default;
const { closeCache } = await import("../app/utils/cache.server.js");

console.log(apply ? "APPLY: changed rows will be written." : "DRY RUN: nothing will be written. Pass --apply to write.");
const result = await recalculateSessionTotals({ shopIds, apply });
const cell = (v) => (v === null ? "NULL" : String(v));
for (const { shop, day, from, to } of result.changes) {
  console.log(`${shop} ${day}  wishlist ${cell(from.wishlistSessions)} -> ${to.wishlistSessions}, notifyMe ${cell(from.notifyMeSessions)} -> ${to.notifyMeSessions}, carried ${cell(from.wishlistSessionsCarried)}/${cell(from.notifyMeSessionsCarried)} -> 0/0`);
}
console.log(`${result.shops} shop(s), ${result.rows} daily row(s) checked, ${result.changed} ${apply ? "needed a change" : "would change"}${apply ? `, ${result.written} written, ${result.stale} skipped (a newer write was already there)` : ""}.`);
await closeCache().catch(() => {});
await prisma.$disconnect();
