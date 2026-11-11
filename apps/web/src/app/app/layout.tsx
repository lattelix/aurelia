import { AppProvider } from "@/components/app-context";
import { PwaRegistration } from "@/components/pwa-registration";
import { Shell } from "@/components/shell";

export default function PlayerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppProvider>
      <Shell>{children}</Shell>
      <PwaRegistration />
    </AppProvider>
  );
}
