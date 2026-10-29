// Eigene, schlichte Strich-Icons (24er Raster)
const PATHS = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.35-4.35",
  home: "M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-4.5v-5.5h-5V21H5a1 1 0 0 1-1-1z",
  plus: "M12 5v14M5 12h14",
  page: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v5h5M9 13h6M9 17h6",
  database: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  chevronRight: "m9 6 6 6-6 6",
  chevronDown: "m6 9 6 6 6-6",
  chevronLeft: "m15 6-6 6 6 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  star: "m12 4 2.47 5 5.53.8-4 3.9.94 5.5L12 16.6l-4.94 2.6.94-5.5-4-3.9 5.53-.8z",
  starFilled: "m12 4 2.47 5 5.53.8-4 3.9.94 5.5L12 16.6l-4.94 2.6.94-5.5-4-3.9 5.53-.8z",
  sidebar: "M4 5h16v14H4zM9 5v14",
  doubleLeft: "m11 17-5-5 5-5M18 17l-5-5 5-5",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  table: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  board: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  calendar: "M5 6h14v14H5zM5 10h14M9 3v4M15 3v4",
  gallery: "M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z",
  filter: "M4 6h16M7 12h10M10 18h4",
  sort: "M8 5v14M4 15l4 4 4-4M16 19V5M12 9l4-4 4 4",
  text: "M5 7h14M5 12h14M5 17h9",
  hash: "M9 4 7 20M17 4l-2 16M4 9h16M3 15h16",
  select: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-3 7 3 3 3-3",
  tags: "M4 4h8l8 8-8 8-8-8zM8.5 8.5h.01",
  status: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4a4 4 0 1 0 0 8V8Z",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
  checkbox: "M5 5h14v14H5zM8.5 12l2.5 2.5 4.5-5",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  phone: "M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5L16 13l4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2Z",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4v4l3 2",
  title: "M5 6h14M12 6v13",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  eyeOff: "M4 4l16 16M10.6 6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-2.9 3.7M6.6 7.6A16.5 16.5 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  copy: "M8 8h11v12H8zM5 16V4h11",
  duplicate: "M8 8h11v12H8zM5 16V4h11M13.5 11v6M10.5 14h6",
  move: "M12 4v16M4 12h16M12 4l-3 3M12 4l3 3M12 20l-3-3M12 20l3-3M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  upload: "M12 20V9M7 14l5-5 5 5M5 4h14",
  lock: "M7 11h10v9H7zM9 11V8a3 3 0 0 1 6 0v3",
  unlock: "M7 11h10v9H7zM9 11V8a3 3 0 0 1 5.8-1",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6 6 0 0 1 3 5.5",
  template: "M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z",
  restore: "M4 12a8 8 0 1 0 2.4-5.7L4 8.6M4 4v4.6h4.6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z",
  logout: "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10",
  drag: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  font: "M5 19 11 5h2l6 14M7.5 14h9",
  width: "M4 12h16M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3M4 5v14M20 5v14",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01",
  smile: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM9 14a4 4 0 0 0 6 0M9 10h.01M15 10h.01",
  check: "m5 12 4.5 4.5L19 7",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; className?: string }) {
  const size = props.size ?? 16;
  return (
    <svg
      className={props.className ? `nk-icon ${props.className}` : "nk-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={props.name === "starFilled" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
