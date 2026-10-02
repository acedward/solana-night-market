// The key every per-client cap counts under (AA 00047 P10, audit round 2 R2-1 / R2-8, F-A2-1 and
// F-A2-6): the client's address, with an IPv6 address cut to its network prefix.
//
// One IPv6 customer line usually gets a whole /64 (2^64 addresses), so caps keyed by the full
// address let one client be 1,667 "clients" (the nonce store) or 34 (the registration cap). Every
// per-client limit (the rate limits, the registration caps, the nonce issuance) therefore keys an
// IPv6 client by its /64 (`CLIENT_IPV6_PREFIX`), and an IPv4 client by its whole address
// (`CLIENT_IPV4_PREFIX` 32; a deployment that sees many clients behind one /24 may lower it).
// An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`, as dual-stack sockets report IPv4 clients) is
// treated as the IPv4 address. Anything that does not parse as an address (`unknown`) is its own key.

export interface ClientPrefixes {
  /** Prefix length an IPv6 client is keyed by (default 64). */
  ipv6: number;
  /** Prefix length an IPv4 client is keyed by (default 32: the whole address). */
  ipv4: number;
}

export const DEFAULT_CLIENT_PREFIXES: ClientPrefixes = { ipv6: 64, ipv4: 32 };

/** The four bytes of a dotted-quad IPv4 address, or null. */
function ipv4Bytes(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** The sixteen bytes of an IPv6 address (with `::`, and an embedded IPv4 tail), or null. */
function ipv6Bytes(s: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(s) || s.split('::').length > 2) return null;
  let tail: number[] = [];
  let text = s;
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.', lastColon)) {
    const v4 = ipv4Bytes(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    text = `${text.slice(0, lastColon + 1)}0:0`; // two placeholder groups, replaced below
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const h = groups(head);
  const r = groups(rest);
  if (rest === undefined && h.length !== 8) return null;
  if (rest !== undefined && h.length + r.length > 7) return null;
  const all = rest === undefined ? h : [...h, ...Array<string>(8 - h.length - r.length).fill('0'), ...r];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

/** Keep the first `bits` bits of `bytes`, zero the rest. */
function prefix(bytes: number[], bits: number): number[] {
  return bytes.map((b, i) => {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    return keep === 8 ? b : keep === 0 ? 0 : b & (0xff << (8 - keep)) & 0xff;
  });
}

/**
 * The per-client key of `address`: `v4:<a.b.c.d>/<n>` or `v6:<16 bytes hex>/<n>` (the address cut to
 * its prefix), or the input itself when it is not an IP address.
 */
export function clientKey(address: string, prefixes: ClientPrefixes = DEFAULT_CLIENT_PREFIXES): string {
  let a = address.trim();
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') === -1 ? undefined : a.indexOf(']'));
  a = a.replace(/%.*$/, ''); // an IPv6 zone index (fe80::1%eth0)
  const v4 = ipv4Bytes(a);
  if (v4) return `v4:${prefix(v4, prefixes.ipv4).join('.')}/${prefixes.ipv4}`;
  const v6 = ipv6Bytes(a);
  if (!v6) return address;
  // An IPv4-mapped address (::ffff:a.b.c.d) is an IPv4 client.
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    return `v4:${prefix(v6.slice(12), prefixes.ipv4).join('.')}/${prefixes.ipv4}`;
  }
  const hex = prefix(v6, prefixes.ipv6)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v6:${hex}/${prefixes.ipv6}`;
}
