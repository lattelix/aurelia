import { SiteShell } from "@/components/website/site-shell";
export default function WebsiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteShell>{children}</SiteShell>;
}
