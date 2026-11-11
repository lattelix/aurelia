import type { CapacitorConfig } from "@capacitor/cli";
const serverUrl = process.env.CAPACITOR_SERVER_URL;
let serverOrigin: string | undefined;
if (serverUrl) {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error("CAPACITOR_SERVER_URL must be a trusted HTTPS origin.");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && process.env.CAPACITOR_DEV === "true")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Native shells require a trusted HTTPS origin without credentials, paths or query strings. Local HTTP requires CAPACITOR_DEV=true.",
    );
  serverOrigin = url.origin;
}
const config: CapacitorConfig = {
  appId: "com.lattelix.aurelia",
  appName: "Aurelia",
  webDir: "www",
  backgroundColor: "#171918",
  loggingBehavior: process.env.CAPACITOR_DEV === "true" ? "debug" : "none",
  ios: {
    contentInset: "never",
    allowsLinkPreview: false,
    preferredContentMode: "mobile",
  },
  ...(serverOrigin
    ? {
        server: {
          url: serverOrigin,
          cleartext: process.env.CAPACITOR_DEV === "true",
          errorPath: "index.html",
        },
      }
    : {}),
};
export default config;
