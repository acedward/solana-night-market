// Small presentation helpers shared by the design components and the pages.

/** Join class names, skipping empty ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** "e8d3…2d09": a long hex value shortened for display (the full value belongs in `title`). */
export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
