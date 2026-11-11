import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { SKIN_COLORS, themeInitScript } from "@/components/theme-contract";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "./globals.css";
import "@/components/theme-presets.css";
import "@/components/listening-layout.css";
export const metadata: Metadata = {
  title: "Aurelia — A little closer to the music",
  description:
    "Your own space for music. Discover, listen, and keep the songs you love.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Aurelia",
  },
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: SKIN_COLORS.base.dark,
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body>
        {/* Blocking script: resolves the persisted/system theme before
            first paint so there's no bright/dark flash. Runs ahead of
            React, so `<html>` picks up attributes hydration doesn't know
            about — hence suppressHydrationWarning above. */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
