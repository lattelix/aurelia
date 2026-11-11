import { spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535.");
const origin = `http://localhost:${port}`;

async function available() {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const health = await response.json();
    return (
      response.ok &&
      health.status === "ok" &&
      ["pglite", "postgresql"].includes(health.database)
    );
  } catch {
    return false;
  }
}

if (await available()) {
  console.log(`Aurelia is already running: ${origin}`);
} else {
  const directory = resolve(root, ".runtime");
  await mkdir(directory, { recursive: true });
  const logPath = resolve(directory, "preview.log");
  const log = await open(logPath, "a", 0o600);
  const child = spawn(process.execPath, [resolve(root, "scripts/start.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      APP_URL: process.env.APP_URL ?? origin,
    },
  });
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await available()) {
      console.log(`Aurelia is running: ${origin} (PID ${child.pid})`);
      console.log(`Logs: ${logPath}`);
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`Aurelia could not start. Check ${logPath}`);
  process.exitCode = 1;
}
