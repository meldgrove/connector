import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Cable,
  Home,
  KeyRound,
  Network,
  ScrollText,
  Search,
  Sparkles,
  Unplug,
  UsersRound,
  Contact,
  Download,
  Gauge,
} from "lucide-react";
import { defineMessages } from "@/i18n";

export const navMessages = defineMessages({
  en: {
    find: "Find",
    home: "Home",
    search: "Search",
    context: "Context",
    people: "People",
    agents: "AI agents",
    connect: "Connect an agent",
    admin: "Administration",
    status: "Status",
    sources: "Sources",
    adminPeople: "People",
    directory: "Directory",
    serviceTokens: "Service tokens",
    activity: "Activity",
    audit: "Audit log",
    updates: "Updates",
  },
});

export type NavKey = keyof typeof navMessages.en;
export type NavItem = { key: NavKey; to: string; icon: LucideIcon };
export type NavGroup = { key: NavKey; items: NavItem[]; adminOnly: boolean };

/** The sidebar's groups. The server checks access too. */
export const NAVIGATION: NavGroup[] = [
  {
    key: "find",
    adminOnly: false,
    items: [
      { key: "home", to: "/", icon: Home },
      { key: "search", to: "/search", icon: Search },
      { key: "context", to: "/context", icon: Sparkles },
      { key: "people", to: "/people", icon: Contact },
    ],
  },
  {
    key: "agents",
    adminOnly: false,
    items: [{ key: "connect", to: "/connect", icon: Cable }],
  },
  {
    key: "admin",
    adminOnly: true,
    items: [
      { key: "status", to: "/admin", icon: Gauge },
      { key: "sources", to: "/admin/sources", icon: Unplug },
      { key: "adminPeople", to: "/admin/people", icon: UsersRound },
      { key: "directory", to: "/admin/directory", icon: Network },
      { key: "serviceTokens", to: "/admin/service-tokens", icon: KeyRound },
      { key: "activity", to: "/admin/activity", icon: Activity },
      { key: "audit", to: "/admin/audit", icon: ScrollText },
      { key: "updates", to: "/admin/updates", icon: Download },
    ],
  },
];
