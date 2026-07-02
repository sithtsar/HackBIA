import type { GraphNode } from "../types";

type GlyphProps = {
  kind: GraphNode["kind"];
  className?: string;
};

/**
 * Small inline-SVG kind glyphs. No icon library — hand-rolled to match the
 * dense instrument-panel look and keep the bundle free of an icon dep for
 * five fixed shapes.
 */
export function Glyph({ kind, className }: GlyphProps) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    className,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
  };

  switch (kind) {
    case "source":
      // cylinder
      return (
        <svg {...common}>
          <ellipse cx="8" cy="4" rx="5.5" ry="2.2" />
          <path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4" />
        </svg>
      );
    case "object":
      // cube
      return (
        <svg {...common}>
          <path d="M8 1.5 14 4.5 8 7.5 2 4.5Z" />
          <path d="M2 4.5v7L8 14.5v-7Z" />
          <path d="M14 4.5v7L8 14.5v-7Z" />
        </svg>
      );
    case "metric":
      // sigma
      return (
        <svg {...common}>
          <path d="M3 2.5h9L8 8l4 5.5H3L7 8Z" />
        </svg>
      );
    case "insight":
      // alert triangle
      return (
        <svg {...common}>
          <path d="M8 2 14.5 13.5h-13Z" strokeLinejoin="round" />
          <path d="M8 6.3v3.4" strokeLinecap="round" />
          <circle cx="8" cy="11.6" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "action":
      // arrow-up-right
      return (
        <svg {...common}>
          <path d="M4.5 11.5 11.5 4.5" strokeLinecap="round" />
          <path d="M6 4.5h5.5V10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}
