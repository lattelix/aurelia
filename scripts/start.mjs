import { cp, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(resolve(root, "apps/web/.env.local"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const output = resolve(root, "apps/web/.next/standalone/apps/web");
try {
  await access(resolve(output, "server.js"));
} catch {
  console.error("Build the web application first: npm run build");
  process.exit(1);
}
await cp(resolve(root, "apps/web/public"), resolve(output, "public"), {
  recursive: true,
});
await cp(
  resolve(root, "apps/web/.next/static"),
  resolve(output, ".next/static"),
  { recursive: true },
);
const child = spawn(process.execPath, [resolve(output, "server.js")], {
  stdio: "inherit",
  cwd: output,
  env: {
    ...process.env,
    PORT: process.env.PORT ?? "3000",
    HOSTNAME: process.env.HOSTNAME ?? "0.0.0.0",
    DATA_DIR: process.env.DATA_DIR ?? resolve(root, ".data"),
  },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
