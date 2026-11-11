import type { ReactNode } from "react";
const paths: Record<string, ReactNode> = {
  select: <path d="m5 3 14 9-7 1-3 7z" />,
  text: <path d="M4 5V3h16v2M12 3v18m-4 0h8" />,
  draw: <path d="m4 17-1 4 4-1L20 7a2.1 2.1 0 0 0-3-3ZM14 7l3 3" />,
  arrow: <path d="M5 19 19 5M8 5h11v11" />,
  sticky: (
    <path d="M14 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9m0 0-7 7m7-7h-5a2 2 0 0 0-2 2v5" />
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m4 17 5-5 4 4 3-3 4 4" />
      <circle cx="15.5" cy="8" r="1.5" />
    </>
  ),
  paste: (
    <>
      <path d="M8 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" />
      <rect x="8" y="2" width="8" height="5" rx="1.5" />
    </>
  ),
  undo: (
    <>
      <path
        d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14"
        transform="translate(0 -2)"
      />
    </>
  ),
  redo: (
    <g transform="translate(24 0) scale(-1 1)">
      <path d="m8 2-5 5 5 5M3 7h10a7 7 0 0 1 0 14" />
    </g>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6" />
    </>
  ),
  mark: (
    <path d="M12 4c5 0 9 2.7 9 6s-4 6-9 6c-1 0-2-.1-2.9-.3L5 19l.8-4.3C4.1 13.6 3 11.9 3 10c0-3.3 4-6 9-6Z" />
  ),
  send: <path d="M21 3 3 10.5l7.5 3L13.5 21ZM21 3 10.5 13.5" />,
  fit: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />,
  minus: <path d="M5 12h14" />,
  plus: <path d="M5 12h14M12 5v14" />,
  capture: (
    <>
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </>
  ),
};
export function Icon({ name }: { name: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
