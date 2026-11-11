import { notFound } from "next/navigation";
import { Screen } from "@/components/screens";

const screens = new Set([
  "search",
  "library",
  "liked",
  "mix",
  "playlist",
  "album",
  "artist",
  "queue",
  "history",
  "recommendations",
  "import",
  "account",
  "settings",
]);
export default async function PlayerScreen({
  params,
}: {
  params: Promise<{ route: string[] }>;
}) {
  const { route } = await params;
  if (!screens.has(route[0])) notFound();
  return <Screen route={route} />;
}
