export type Format = "landscape" | "square" | "portrait";
export const FPS = 30;
export const FORMATS: Record<Format, { width: number; height: number; id: string }> = {
  landscape: { width: 1920, height: 1080, id: "Overview16x9" },
  square: { width: 1080, height: 1080, id: "Overview1x1" },
  portrait: { width: 1080, height: 1920, id: "Overview9x16" },
};
export const C = {
  bg: "#0a1128", deep: "#070c1d", panel: "#13224f", cream: "#f4f2ec", muted: "#8e9cbd",
  blue: "#2f5bea", light: "#b6c9ed", loss: "#c0504d", line: "rgba(182,201,237,0.35)",
} as const;
/** Base type size per format (px); scenes scale from it so text stays phone-legible. */
export const BASE: Record<Format, number> = { landscape: 44, square: 46, portrait: 54 };
