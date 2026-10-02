/** Joins class names, skipping falsy parts. Re-exported by ui.tsx. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
