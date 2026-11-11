import { createRoot } from "react-dom/client";
import { AppProvider, useApp } from "../../../apps/web/src/components/app-context";
import { ThemeProvider } from "../../../apps/web/src/components/theme-provider";
import { Shell } from "../../../apps/web/src/components/shell";
import { Screen } from "../../../apps/web/src/components/screens";
import { screenRoute, usePathname } from "./navigation";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "../../../apps/web/src/app/globals.css";
import "../../../apps/web/src/components/theme-presets.css";
import "../../../apps/web/src/components/listening-layout.css";
import "./preview.css";
import { publicMetadataEnabled, previewStatus } from "./preview-mode";
import { nativeCloudSessionAvailable } from "./native-cloud-session";

function RoutedScreen() {
  const path = usePathname();
  const route = screenRoute(path);
  const { data, loading, error } = useApp();
  const status = previewStatus({
    profileMode: publicMetadataEnabled,
    nativeSession: nativeCloudSessionAvailable(),
    signedIn: data.user !== null,
    loading,
    failed: error !== null,
  });
  return (
    <>
      <aside
        className="bundled-probe-status"
        aria-label="Private preview status"
      >
        <strong>{status.title}</strong>
        <span>{status.description}</span>
      </aside>
      {route === null ? (
        <div className="page">
          <h1>Page unavailable</h1>
          <p>This address is not part of this private preview.</p>
          <a className="button secondary" href="#/">
            Return home
          </a>
        </div>
      ) : (
        <Screen route={route} />
      )}
    </>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("The bundled preview root is missing.");
createRoot(container).render(
  <ThemeProvider>
    <AppProvider>
      <Shell>
        <RoutedScreen />
      </Shell>
    </AppProvider>
  </ThemeProvider>,
);
