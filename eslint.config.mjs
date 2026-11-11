import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      "**/.next/**",
      "**/node_modules/**",
      "apps/mobile/ios/**",
      "apps/mobile/android/**",
    ],
  },
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
    },
  },
  { settings: { next: { rootDir: "apps/web/" } } },
];
