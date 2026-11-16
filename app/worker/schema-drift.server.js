import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Does the database match THIS build? The worker and the web app are built into an image together with a generated Prisma client,
// and the database is migrated separately. When the database is ahead of the image, the old client cannot read what the new code
// wrote: for example a row whose enum value the client has never heard of makes every query that reads it fail with a bare
// PrismaClientUnknownRequestError ("Value 'X' not found in enum"), for that day only, again on every run. This says so plainly.
//
// Read-only: it lists the migrations the database has applied (_prisma_migrations) and compares their names with the migration
// folders this build contains. Nothing is written and nothing is applied.
//   unknownToBuild  applied in the database, absent from this build  -> the image is older than the database: rebuild it
//   pendingInDb     in this build, not applied in the database       -> run `prisma migrate deploy`
const MIGRATIONS_DIR = fileURLToPath(new URL("../../prisma/migrations/", import.meta.url));

export async function checkSchemaDrift(prisma, dir = MIGRATIONS_DIR) {
  const inBuild = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name)).map((entry) => entry.name);
  const rows = await prisma.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const applied = rows.map((row) => String(row.migration_name));
  return {
    unknownToBuild: applied.filter((name) => !inBuild.includes(name)).sort(),
    pendingInDb: inBuild.filter((name) => !applied.includes(name)).sort(),
  };
}

// The lines the worker prints (none when everything matches). Migration names only: no data.
export function driftMessages({ unknownToBuild, pendingInDb }) {
  const lines = [];
  if (unknownToBuild.length) {
    lines.push(`the database has migrations this build does not include (${unknownToBuild.join(", ")}): this build is older than the database (a stale image, or the database was migrated from another branch). Rebuild and restart the web and worker images from a build that includes them so their Prisma client matches; until then any day whose data uses the newer schema can fail to summarise.`);
  }
  if (pendingInDb.length) lines.push(`this build has migrations the database has not applied (${pendingInDb.join(", ")}): run "prisma migrate deploy".`);
  return lines;
}
