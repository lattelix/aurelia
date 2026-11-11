import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output-root") {
  throw new Error("Use --output-root <directory inside the checkout> explicitly.");
}
const output = resolve(root, args[1]);
const inside = relative(root, output);
if (isAbsolute(inside) || inside === ".." || inside.startsWith("../")) {
  throw new Error("Artwork output must stay inside this checkout.");
}
await mkdir(output, { recursive: true });
if ((await realpath(output)) !== output) throw new Error("Symlinked output is not allowed.");

// These inputs are the original CC0 SVG assets, not provider album covers.
const jobs = [
  ...["afterglow", "parallel", "blue-hours", "still-life"].map((name) => ({
    input: `apps/web/public/art/${name}.svg`,
    output: `apps/apple/Sources/AureliaAppleUI/Resources/Art/${name}.png`,
    size: 640,
    opaque: true,
  })),
  { input: "apps/web/public/icon.svg", output: "apps/apple/Sources/AureliaAppleUI/Resources/Art/aurelia-icon.png", size: 512 },
  { input: "apps/web/public/icon.svg", output: "apps/apple/iOS/Assets.xcassets/AppIcon.appiconset/Icon-1024.png", size: 1024 },
];
for (const job of jobs) {
  const target = resolve(output, job.output);
  await mkdir(dirname(target), { recursive: true });
  if ((await realpath(dirname(target))) !== dirname(target)) {
    throw new Error("Symlinked artwork destination is not allowed.");
  }
  try {
    const current = await lstat(target);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error("Artwork destination must be a regular file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let image = sharp(resolve(root, job.input)).resize(job.size, job.size);
  if (job.opaque) image = image.flatten({ background: "#ffffff" });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, await image.png().toBuffer(), { flag: "wx", mode: 0o644 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
console.log(`Generated ${jobs.length} Apple artwork derivatives from original CC0 SVGs.`);
