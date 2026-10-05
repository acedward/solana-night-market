// AA 00060 P11.3: the About page's known limitations. A site that bridges lists the bridging limits too
// (README "Bridging (AA 00060)"); a site that does not bridge lists only the market's own. The own-offer and
// no-cancel limits (questions Q9, spec FR-028) say what the page does now.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { About, BRIDGE_LIMITS } from '../src/pages/About.js';

const ids = (html: string) => [...html.matchAll(/data-limit="([^"]+)"/g)].map((m) => m[1]);

describe('About: known limitations', () => {
  it('a bridging site adds the bridging limits after the market’s own; a site that does not bridge has none', () => {
    const plain = ids(renderToStaticMarkup(<About networkName="Midnight undeployed" />));
    const bridging = ids(renderToStaticMarkup(<About networkName="Midnight undeployed" bridging />));
    expect(plain.some((id) => id!.startsWith('bridge-'))).toBe(false);
    expect(bridging).toEqual([...plain, ...BRIDGE_LIMITS.map((l) => l.id)]);
    expect(BRIDGE_LIMITS.map((l) => l.id)).toContain('bridge-rpc');
  });

  it('your own offer cannot be taken, and offers cannot be cancelled', () => {
    const html = renderToStaticMarkup(<About networkName="Midnight undeployed" />);
    expect(html).toContain('You cannot take your own offer.');
    expect(html).not.toContain('Cancel it instead');
    expect(html).toContain('Offers cannot be cancelled; they expire.');
    expect(html).toContain('A future Offer Files feature will provide cancellation for every client.');
  });

  it('the Solana RPC limit says it is trusted, in the owner’s words', () => {
    const rpc = BRIDGE_LIMITS.find((l) => l.id === 'bridge-rpc')!;
    expect(rpc.text).toContain('wrongly say nothing was locked');
    expect(rpc.text).toContain('into your own account');
  });
});
