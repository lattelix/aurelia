// This process receives no application environment or credentials. Its only
// readable application file is this entrypoint; dependency reads are allowed.
import process from "node:process";

let phase = "input";
let reason = "UNAVAILABLE";
async function input() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 6_000_000) throw new Error("Input too large");
  }
  return JSON.parse(text);
}
async function player(script) {
  if (typeof script !== "string" || script.length > 4_000_000)
    throw new Error("Invalid player script");
  const { getQuickJS, shouldInterruptAfterDeadline } =
    await import("quickjs-emscripten");
  const vm = await getQuickJS();
  return vm.evalCode(`(function(){${script}\n})()`, {
    memoryLimitBytes: 64 * 1024 * 1024,
    maxStackSizeBytes: 256 * 1024,
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 2000),
  });
}
async function attestation(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id))
    throw new Error("Invalid content binding");
  const { BotGuardClient } = await import("bgutils-js/botguard");
  const { buildURL, parseLooseJSON, getHeaders, USER_AGENT } =
    await import("bgutils-js/utils");
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const request = (url, init = {}) =>
    fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  phase = "page";
  const response = await request("https://www.youtube.com/", {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.7" },
  });
  if (!response.ok) throw new Error("Page unavailable");
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error("Page too large");
  phase = "challenge";
  const configText = html.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  const challengeText = html.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/)?.[1];
  reason = "MISSING_PAGE_CHALLENGE";
  if (!configText || !challengeText) throw new Error("No page challenge");
  const config = JSON.parse(configText);
  const challenge = parseLooseJSON(challengeText).R?.bgChallenge;
  const visitorData = config.VISITOR_DATA ?? config.INNERTUBE_CONTEXT?.client?.visitorData;
  reason = "INCOMPLETE_CHALLENGE";
  if (!challenge?.program)
    throw new Error("Incomplete challenge");
  const url = new URL(
    challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue,
    "https://www.youtube.com",
  );
  reason = "INVALID_INTERPRETER_URL";
  if (
    url.protocol !== "https:" ||
    !["www.google.com", "www.youtube.com"].includes(url.hostname) ||
    !/^\/js\/(?:bg|th)\//.test(url.pathname) ||
    url.port || url.username || url.password
  ) throw new Error("Invalid interpreter URL");
  phase = "interpreter";
  reason = "UNAVAILABLE";
  const scriptResponse = await request(url);
  if (!scriptResponse.ok) throw new Error("Interpreter unavailable");
  const script = await scriptResponse.text();
  if (script.length > 2_000_000) throw new Error("Interpreter too large");
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><head><title>YouTube</title></head><body></body></html>',
    {
      url: "https://www.youtube.com/",
      referrer: "https://www.youtube.com/",
      runScripts: "outside-only",
      virtualConsole: new VirtualConsole(),
    },
  );
  let botguard;
  try {
    dom.window.yt = { config_: config };
    dom.window.eval(script);
    phase = "snapshot";
    botguard = await BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: dom.window,
    });
    const signals = [];
    const snapshot = await botguard.snapshot({ webPoSignalOutput: signals });
    phase = "integrity";
    const integrityResponse = await request(buildURL("GenerateIT", true), {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(["O43z0dpjhgX20SCx4KAo", snapshot]),
    });
    if (!integrityResponse.ok) throw new Error("Integrity unavailable");
    const [integrity, ttl] = await integrityResponse.json();
    if (typeof integrity !== "string" || integrity.length > 16_384)
      throw new Error("Invalid integrity token");
    phase = "mint";
    // BgUtils' instanceof guards expect one realm. Keep callback inputs in
    // the DOM realm and use structural validation at the process boundary.
    const bytes = dom.window.Uint8Array.from(Buffer.from(integrity, "base64"));
    const mint = await signals[0]?.(bytes);
    if (typeof mint !== "function") throw new Error("No minter");
    const minted = await mint(dom.window.Uint8Array.from(Buffer.from(id)));
    if (!minted || minted.byteLength < 32 || minted.byteLength > 4096)
      throw new Error("Invalid proof");
    return {
      token: Buffer.from(minted).toString("base64url"),
      visitorData,
      userAgent: USER_AGENT,
      expiresAt: Date.now() + Math.min(Number(ttl) || 600, 3600) * 1000,
    };
  } finally {
    await botguard?.shutdown().catch(() => {});
    dom.window.close();
  }
}
try {
  const data = await input();
  const result =
    data.kind === "player"
      ? await player(data.script)
      : data.kind === "attestation"
        ? await attestation(data.id)
        : (() => { throw new Error("Invalid task"); })();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  // No raw errors, scripts, URLs or tokens cross the logging boundary.
  const code = ["ENOENT", "ERR_ACCESS_DENIED", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE_ESM", "ERR_REQUIRE_ASYNC_MODULE"].includes(error?.code) ? error.code : undefined;
  process.stderr.write(JSON.stringify({ phase, reason, code, type: error?.name ?? "Error" }));
  process.exitCode = 1;
}
