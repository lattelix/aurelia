import sharp from "sharp";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
const base = "apps/mobile/ios/App/App/Assets.xcassets";
const icon = await readFile("apps/web/public/icon.svg");
await sharp(icon)
  .resize(1024, 1024)
  .flatten({ background: "#171918" })
  .png()
  .toFile(`${base}/AppIcon.appiconset/AppIcon-512@2x.png`);
const splash = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732"><rect width="2732" height="2732" fill="#171918"/><circle cx="1366" cy="1290" r="136" fill="#eaba73"/><path d="M1310 1340v-100l115 50z" fill="#171918"/><text x="1366" y="1530" text-anchor="middle" fill="#f5f1e8" font-family="sans-serif" font-size="75" letter-spacing="14">AURELIA</text></svg>',
);
for (const suffix of ["", "-1", "-2"])
  await sharp(splash)
    .png()
    .toFile(`${base}/Splash.imageset/splash-2732x2732${suffix}.png`);
const android = "apps/mobile/android/app/src/main/res";
for (const [density, size] of Object.entries({
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
})) {
  const directory = `${android}/mipmap-${density}`;
  await mkdir(directory, { recursive: true });
  const bytes = await sharp(icon).resize(size, size).png().toBuffer();
  for (const name of ["ic_launcher", "ic_launcher_round"])
    await writeFile(`${directory}/${name}.png`, bytes);
  const canvas = Math.round((size * 108) / 48);
  const inset = Math.round(canvas * 0.66);
  const foreground = await sharp(icon).resize(inset, inset).png().toBuffer();
  await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: "#171918",
    },
  })
    .composite([{ input: foreground, gravity: "centre" }])
    .png()
    .toFile(`${directory}/ic_launcher_foreground.png`);
}
await writeFile(
  `${android}/values/ic_launcher_background.xml`,
  '<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">#171918</color></resources>\n',
);
for (const entry of await readdir(android, { withFileTypes: true })) {
  if (
    !entry.isDirectory() ||
    !/^drawable(?:-(?:land|port)-[a-z]+)?$/.test(entry.name)
  )
    continue;
  const path = `${android}/${entry.name}/splash.png`;
  let metadata;
  try {
    metadata = await sharp(path).metadata();
  } catch {
    continue;
  }
  if (!metadata.width || !metadata.height) continue;
  await writeFile(
    path,
    await sharp(splash)
      .resize(metadata.width, metadata.height, {
        fit: "contain",
        background: "#171918",
      })
      .png()
      .toBuffer(),
  );
}
await mkdir("apps/web/public/licenses", { recursive: true });
for (const font of ["dm-sans", "manrope"]) {
  const license = await readFile(
    `node_modules/@fontsource-variable/${font}/LICENSE`,
  );
  await writeFile(`apps/web/public/licenses/${font}.txt`, license);
}
