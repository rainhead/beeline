import type { Messages } from "../messages/index.js";
import { PageHeader } from "./components/index.js";

/**
 * The program calendar (beeline-2zej.1.12): the Master Melittologist Google
 * Calendar, which staff keep, shown in a frame. Beeline stores none of it.
 *
 * Google's embed has a fixed size by default; here it fills the page, and
 * the address picks a view that suits the width. Two frames are rendered, a
 * month grid for wide screens and an agenda list for phones, and a media
 * query (`.calendar-frame` in components.css) hides one. Both are
 * `loading="lazy"`, which a browser does not fetch while the frame is
 * hidden, so a reader loads only the one they see.
 */
const CALENDAR_ID = "oregonstate.edu_igc7gl5p7kkg1hjin0j2ao3lpc@group.calendar.google.com";

export function calendarSrc(mode: "MONTH" | "AGENDA"): string {
  const q = new URLSearchParams({
    src: CALENDAR_ID,
    ctz: "America/Los_Angeles",
    mode,
    showTitle: "0",
    showPrint: "0",
    showTz: "0",
    showCalendars: "0",
  });
  return `https://calendar.google.com/calendar/embed?${q.toString()}`;
}

export function Calendar({ m }: { m: Messages }) {
  return (
    <>
      <PageHeader title={m.calendar.heading} lede={m.calendar.lede} />
      <iframe
        class="calendar-frame calendar-frame-wide"
        src={calendarSrc("MONTH")}
        title={m.calendar.frameTitle}
        loading="lazy"
        referrerpolicy="no-referrer"
      ></iframe>
      <iframe
        class="calendar-frame calendar-frame-narrow"
        src={calendarSrc("AGENDA")}
        title={m.calendar.frameTitle}
        loading="lazy"
        referrerpolicy="no-referrer"
      ></iframe>
    </>
  );
}
