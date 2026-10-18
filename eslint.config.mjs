import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "**/.wrangler/**",
      "coverage/**",
      "dist/**",
      "**/*.d.ts",
      "src/templates.generated.js",
      "public/**",
    ],
  },
  {
    files: [
      "src/**/*.ts",
      "workers/*/*.ts",
      "tests/**/*.ts",
      "browser/**/*.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 12,
        },
      ],
      "no-warning-comments": [
        "error",
        {
          terms: ["c8 ignore", "istanbul ignore", "@ts-ignore", "@ts-nocheck"],
          location: "anywhere",
        },
      ],
    },
  },
);
