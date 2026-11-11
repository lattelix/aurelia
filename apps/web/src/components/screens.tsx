"use client";
import { Home } from "./home";
import { SearchScreen } from "./search-screen";
import {
  LibraryScreen,
  DetailScreen,
  QueueScreen,
  HistoryScreen,
  RecommendationsScreen,
} from "./collection-screens";
import { ImportScreen } from "./import-screen";
import {
  AccountScreen,
  SettingsScreen,
  PrivacyScreen,
} from "./account-screens";
export function Screen({ route }: { route: string[] }) {
  switch (route[0]) {
    case "search":
      return <SearchScreen />;
    case "library":
      return <LibraryScreen />;
    case "liked":
      return <DetailScreen kind="liked" />;
    case "mix":
    case "playlist":
    case "album":
    case "artist":
      return <DetailScreen kind={route[0]} id={route[1]} />;
    case "queue":
      return <QueueScreen />;
    case "history":
      return <HistoryScreen />;
    case "recommendations":
      return <RecommendationsScreen />;
    case "import":
      return <ImportScreen />;
    case "account":
      return <AccountScreen />;
    case "settings":
      return <SettingsScreen />;
    case "privacy":
      return <PrivacyScreen />;
    default:
      return <Home />;
  }
}
