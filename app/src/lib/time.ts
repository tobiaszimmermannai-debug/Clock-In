const TZ = "Europe/Berlin";

const clockFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const clockSecFmt = new Intl.DateTimeFormat("de-DE", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });

export const fmtClock = (d: Date | string) => clockFmt.format(new Date(d));
export const fmtClockSec = (d: Date | string) => clockSecFmt.format(new Date(d));
export const fmtDate = (d: Date | string) => dateFmt.format(new Date(d));

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
