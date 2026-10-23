// Lets node import the app's bundler-style modules (extensionless relative paths)
// directly in tests. Test-only; the production build is untouched.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\\.(m?js|jsx|json)$/.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    for (const suffix of [".js", ".jsx", "/index.js"]) {
      const candidate = new URL(base.href + suffix);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
  }
  return next(specifier, context);
}`),
);
