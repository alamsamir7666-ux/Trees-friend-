// @ts-check
/**
 * Root ESLint flat config (ESLint 9 + typescript-eslint v8).
 *
 * Industry-standard baseline for a TypeScript monorepo:
 *   - @eslint/js recommended rules
 *   - typescript-eslint recommended (type-aware rules OFF for speed — see
 *     `typescript-eslint/recommended` vs `recommendedTypeChecked`)
 *   - Prettier integration (eslint-config-prettier disables conflicting rules)
 *   - Node globals for API server / scripts
 *
 * Per-package overrides live in this file (not per-package configs) so the
 * monorepo has ONE source of truth for lint rules. This is the standard
 * pattern for pnpm workspaces.
 *
 * Usage:
 *   pnpm lint          # lint everything
 *   pnpm lint --fix    # auto-fix
 *   pnpm format        # prettier write
 *
 * The pre-commit hook (husky + lint-staged) runs eslint --fix + prettier
 * --write on staged files only, so lint errors can't ship.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // ─── Global ignores ──────────────────────────────────────────────────────
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      "**/*.config.{js,cjs,mjs,ts}",
      // Generated code — never lint
      "lib/api-zod/src/generated/**",
      "lib/api-client-react/src/generated/**",
      "artifacts/api-server/dist/**",
      // Migration SQL files
      "**/*.sql",
    ],
  },

  // ─── Base: JS recommended + TS recommended ───────────────────────────────
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ─── All TypeScript files ────────────────────────────────────────────────
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // ─── Industry-standard additions to typescript-eslint/recommended ───
      // Enforce consistent type imports (Node 24 + TypeScript 5.9 supports
      // `import type` fully; mixing runtime + type imports in one statement
      // bloats bundles and can cause runtime errors in ESM CJS interop).
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
          disallowTypeAnnotations: true,
        },
      ],
      // No unused vars — but allow args prefixed with _ (intentional skips,
      // e.g. `_req` in handlers that don't read the request).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Allow `any` for now (231 existing uses) but warn — gradual migration.
      // The audit's P1-5 calls for replacing `req: any` with a typed generic;
      // until that's done, blocking `any` would break the build. This rule
      // surfaces `any` uses in editors so they're visible without blocking.
      "@typescript-eslint/no-explicit-any": "warn",
      // Enforce `as const` over literal type assertions where possible.
      "@typescript-eslint/prefer-as-const": "error",
      // No non-null assertions (`foo!`) — use optional chaining or explicit
      // null checks. The codebase has some legitimate uses (Express 5 typing
      // gaps), so this is a warning, not an error.
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Consistent array type style: `T[]` not `Array<T>`.
      "@typescript-eslint/array-type": ["error", { default: "array" }],
      // No `require` in ESM — the codebase is fully ESM.
      "@typescript-eslint/no-require-imports": "error",
      // Enforce `const` where variables are never reassigned.
      "prefer-const": "error",
      // No var — use let/const.
      "no-var": "error",
      // Enforce === over == (catches subtle type coercion bugs).
      eqeqeq: ["error", "always"],
      // No console.log in production code — use the logger (api-server) or
      // remove (frontend). Warn so existing uses are visible but not blocking.
      "no-console": "warn",
    },
  },

  // ─── Frontend (React) files ──────────────────────────────────────────────
  {
    files: ["artifacts/tree-friend/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    rules: {
      // Frontend uses console for dev debugging — allow in dev, the Vite
      // build strips console.* in production via esbuild.
      "no-console": "off",
    },
  },

  // ─── API server files ────────────────────────────────────────────────────
  {
    files: ["artifacts/api-server/src/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // API server uses the pino logger — no console.* allowed in production
      // server code. This is an error (not a warning) because pino is the
      // structured logging standard here.
      "no-console": "error",
    },
  },

  // ─── Test files ──────────────────────────────────────────────────────────
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/test/**/*.ts"],
    rules: {
      // Tests can use console for debug output.
      "no-console": "off",
      // Tests can use `any` for fixture data without lint noise.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ─── Scripts (Node CLI tools) ────────────────────────────────────────────
  {
    files: ["scripts/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // ─── Prettier integration (must be LAST) ─────────────────────────────────
  // eslint-config-prettier disables all ESLint rules that conflict with
  // Prettier formatting (indentation, quotes, semicolons, etc.). This lets
  // ESLint focus on code quality while Prettier handles formatting.
  eslintConfigPrettier,
);
