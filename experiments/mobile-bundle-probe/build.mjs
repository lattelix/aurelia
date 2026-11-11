import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const probe = dirname(fileURLToPath(import.meta.url));
const root = resolve(probe, "../..");
const webDir = join(probe, "www");
const require = createRequire(join(probe, "package.json"));
assert(
  process.argv.slice(2).every((arg) => arg === "--public-metadata"),
  "Only --public-metadata is supported.",
);
const publicMetadata = process.argv.includes("--public-metadata");
let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  throw new Error(
    "Install this experiment's pinned dev dependency explicitly, or use the existing root esbuild 0.28.2. See README; this script never installs packages.",
  );
}
assert.equal(
  esbuild.version,
  "0.28.2",
  "This private probe requires existing esbuild 0.28.2; do not install or upgrade it implicitly.",
);

const source = (name) => join(probe, "src", name);
const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: [source("main.tsx")],
  outdir: webDir,
  entryNames: "assets/app",
  assetNames: "assets/[name]-[hash]",
  bundle: true,
  jsx: "automatic",
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  treeShaking: true,
  metafile: true,
  write: false,
  tsconfig: join(root, "tsconfig.json"),
  nodePaths: [join(root, "node_modules")],
  define: {
    "process.env.NODE_ENV": '"production"',
    __AURELIA_PUBLIC_METADATA__: String(publicMetadata),
  },
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  alias: {
    "next/link": source("navigation.tsx"),
    "next/navigation": source("navigation.tsx"),
    "next/image": source("image.tsx"),
    "@/lib/client-api": source("client-api.ts"),
    "@/lib/native-cloud-session": source("native-cloud-session.ts"),
  },
  logLevel: "warning",
});

// Review the actual graph before any generated files are written.
const inputs = Object.keys(result.metafile.inputs).map((path) =>
  isAbsolute(path) ? path : resolve(root, path),
);
const disallowed = inputs.filter(
  (path) =>
    /(?:^|\/)\.(?:env(?:\.|$)|runtime(?:\/|$)|data(?:\/|$))/.test(path) ||
    /\/packages\/(?:auth|database)\//.test(path) ||
  /\/apps\/web\/src\/lib\/(?!lyrics\.ts$|native-cloud-session\.ts$|client-account\.ts$|app-navigation\.ts$)/.test(path) ||
    /\/node_modules\/(?:pg|pg-pool|@electric-sql\/pglite|youtubei\.js|quickjs-emscripten|bgutils-js|jsdom|next)\//.test(
      path,
    ),
);
assert.deepEqual(
  disallowed,
  [],
  "Client graph contains a disallowed server/runtime input.",
);
for (const name of ["main.tsx", "navigation.tsx", "image.tsx", "client-api.ts", "native-cloud-session.ts", "preview-mode.ts"])
  assert(inputs.includes(source(name)), `Missing mobile adapter: ${name}`);
const externalImports = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external);
assert.deepEqual(
  externalImports,
  [],
  "Browser bundle contains unresolved/external imports.",
);

// This is the existing pure, import-free theme contract. Transform only local
// trusted source to read its exported first-paint script during generation.
const themeFile = join(root, "apps/web/src/components/theme-contract.ts");
const themeSource = await readFile(themeFile, "utf8");
const transformed = await esbuild.transform(themeSource, {
  loader: "ts",
  format: "esm",
  target: "es2022",
  sourcefile: themeFile,
});
assert(
  !/^\s*import\s/m.test(transformed.code),
  "Theme contract unexpectedly imports another module; inspect before executing it.",
);
const theme = await import(
  `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`
);
assert.equal(typeof theme.themeInitScript, "string");
const themeScript = theme.themeInitScript.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#171918">
<meta name="description" content="${publicMetadata ? "Private Aurelia profile preview. Native browser approval connects your library." : "Private bundled guest UI preview. Cloud sign-in is disabled in this build."}">
<title>Aurelia — private bundled preview</title>
<link rel="icon" href="./icon.svg">
<script>${themeScript}</script>
<link rel="stylesheet" href="./assets/app.css">
</head><body>
<div id="root"></div>
<noscript>This private preview needs JavaScript to show the music interface.</noscript>
<script type="module" src="./assets/app.js"></script>
</body></html>\n`;
assert(
  !/<script[^>]+src\s*=\s*["'](?:https?:)?\/\//i.test(html),
  "HTML references a remote UI script.",
);

await rm(webDir, { recursive: true, force: true });
await mkdir(webDir, { recursive: true });
for (const output of result.outputFiles) {
  const destination = resolve(output.path);
  assert(
    destination.startsWith(webDir + sep),
    "Unexpected output destination outside probe/www.",
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output.contents);
}
await writeFile(join(webDir, "index.html"), html);

async function copyLocalPublic(path) {
  const origin = join(root, "apps/web/public", path);
  const destination = join(webDir, path);
  const info = await stat(origin);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(origin, { withFileTypes: true })) {
      assert(
        !entry.isSymbolicLink(),
        "Unexpected symlink in public assets; inspect manually.",
      );
      await copyLocalPublic(join(path, entry.name));
    }
  } else {
    assert(info.isFile(), "Expected a regular public asset.");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(origin));
  }
}
for (const path of [
  "art",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "licenses",
  "sample-import.json",
])
  await copyLocalPublic(path);
// Preserve the repository's public dependency notice verbatim. This is not a
// claim that the notice has undergone a complete native distribution review.
await writeFile(
  join(webDir, "licenses/THIRD_PARTY_NOTICES.md"),
  await readFile(join(root, "THIRD_PARTY_NOTICES.md")),
);
// No public/audio, service worker, manifest or hosted HTML is copied.

async function artifactFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await artifactFiles(path)));
    else {
      const bytes = await readFile(path);
      files.push({
        path: relative(webDir, path),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const files = await artifactFiles(webDir);
assert(files.some((file) => file.path === "assets/app.js"));
assert(files.some((file) => file.path === "assets/app.css"));
assert(files.some((file) => file.path.endsWith(".woff2")));
assert(!files.some((file) => /(?:^audio\/|\.mp3$|^sw\.js$)/.test(file.path)));
await writeFile(
  join(probe, "metafile.json"),
  JSON.stringify(result.metafile, null, 2) + "\n",
);
await writeFile(
  join(probe, "build-evidence.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      esbuildVersion: esbuild.version,
      mode: publicMetadata
        ? "private-bundled-profile-preview"
        : "private-bundled-offline-guest",
      sharedRepository: root,
      webDir,
      inputCount: inputs.length,
      disallowedInputMatches: disallowed,
      externalOutputImports: externalImports,
      remoteHtmlScripts: [],
      cloudApi: publicMetadata
        ? "native session JSON bridge for profile/library/import; guest bootstrap fallback only after confirmed unauthenticated status; public search without plugin; no web audio transport"
        : "disabled: immediate error; no network transport implemented",
      browserYouTubeLoader:
        "shared source retained; native guard must be verified on Android; not required for boot",
      runtimeVerified: false,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Private bundled UI: ${webDir}`);
console.log(`Graph and file evidence: ${join(probe, "build-evidence.json")}`);
console.log(
  "This build does not establish native playback, cloud authentication or physical-device behavior.",
);
