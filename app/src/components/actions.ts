// Gemeinsame Darstellung der vier Stempel-Aktionen (Handy und Tablet)
import type { EventType } from "../lib/types";
import type { IconName } from "./ui";

export const ACTIONS: EventType[] = ["clock_in", "break_start", "break_end", "clock_out"];

export const ACTION_ICON: Record<EventType, IconName> = {
  clock_in: "login",
  break_start: "coffee",
  break_end: "play",
  clock_out: "logout",
};

export const GREETING: Record<EventType, (name: string) => string> = {
  clock_in: (n) => `Hallo ${n}!`,
  break_start: (n) => `Gute Pause, ${n}!`,
  break_end: (n) => `Willkommen zurück, ${n}!`,
  clock_out: (n) => `Schönen Feierabend, ${n}!`,
};
