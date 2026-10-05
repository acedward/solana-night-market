// A token's icon (AA 00060 P12.1b, spec FR-022): an optional `icon` on the site's `tokens` entries (the
// Midnight token) and on the journey registry's entries (I-1 `bridges.tokens`: the SPL token). It is a
// path on the SITE'S OWN origin (the site bundles the images, `web/public/token-icons/`), so the page
// never asks a third party for an image and its Content-Security-Policy (`img-src 'self'`) is unchanged.
//
// Accepted: a relative path (`token-icons/x.png`, resolved against the page) or a site-absolute one
// (`/token-icons/x.png`); segments of letters, digits, `.`, `_` and `-` that never start with a dot (so
// no `..`), ending in .png, .webp or .svg. Anything else (a URL with a scheme, `//host`, a query, `..`)
// is not an icon: the token keeps its text badge, and the configuration is otherwise unaffected (an
// older site ignores the field altogether).

const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}';
const ICON_PATH = new RegExp(`^/?(?:${SEGMENT}/){0,4}${SEGMENT}\\.(?:png|webp|svg)$`);

/** The icon path when `value` is an acceptable site-relative image path, else null. */
export function siteIconPath(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 200 && ICON_PATH.test(value) ? value : null;
}
