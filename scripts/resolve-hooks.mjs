// Node loader hook so the worker can import the app's modules, which use bundler-style extensionless
// relative imports ("../db.server"). Used only by scripts/worker.mjs; the app server and the build are
// not affected.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.(m?js|jsx|json)$/.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    for (const suffix of [".js", ".jsx", "/index.js"]) {
      const candidate = new URL(base.href + suffix);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
  }
  return next(specifier, context);
}
