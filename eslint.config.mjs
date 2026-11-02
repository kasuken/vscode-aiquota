import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".test-data/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["scripts/*.cjs"], languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  }
);
