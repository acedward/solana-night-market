# Night Market web app

A static Vite + React site. Every per-user record lives in the browser's local storage (see
`src/store/`); the relay keeps none. Build it with `bun run build:web` from the repository root.

## The markets (`config.json` `pairs`)

A market is any two tokens, `BASE/QUOTE`: the price is in QUOTE per BASE. The site's markets are
`config.json` `pairs` (a list of `"BASE/QUOTE"` strings), or the network's default pairs
(`NETWORK_DEFAULT_PAIRS` in `packages/core/src/tokens/pairs.ts`; stagenet: twBTC/twUSDC,
twETH/twUSDC, twUSDM/twUSDC, twETH/twBTC). No token is special in the code: a pair without twUSDC
(twETH/twBTC) is read, priced and filtered by the same code as any other. A pair that names an
unknown token, the same token twice or a token without a shielded colour is left out, with a
warning in the browser console (`Night Market: …`).

The tokens are the network's built-in list (stagenet: the vendored
[`effectstream/mint-test-tokens`](https://github.com/effectstream/mint-test-tokens) registry,
`packages/core/src/tokens/mint-test-tokens/`), plus any the site adds in `config.json` `tokens`
(`{ "tokens": [{ "symbol", "decimals", "midnightColour", "name"? }] }`; `"mode": "replace"` replaces
the list, which the local `undeployed` stack needs).

## Each site's asset set (`config.json` `assets`)

One build serves several domains. Each domain serves its own `config.json` next to `index.html`,
and its optional `assets` is that site's asset set: a list of symbols, or `"all"`.

| Site | `config.json` | Shows |
|---|---|---|
| The market domain | `{"network":"stagenet","relayUrl":"/relay"}` | every token and every default market |
| A partner domain | `{"network":"stagenet","relayUrl":"/relay","assets":["twETH","twBTC"]}` | twETH and twBTC, and their one market |
| Any site | `{"network":"stagenet","relayUrl":"/relay","assets":"all"}` | every token and market |

- Without `assets`, a site shows its network's default set: data beside the network profiles
  (`NETWORK_DEFAULT_ASSETS` in `packages/core/src/network.ts`). Stagenet's is every token (null).
- Symbols match in any case. A symbol the market does not have is ignored, with a warning in the
  browser console (`Night Market: …`). If none is known, the network's default set applies, with a
  warning: a typo never blanks the site.
- The site needs a **secure origin** (https, or `localhost` in development). The page derives and
  encrypts the account's keys with WebCrypto, which browsers only offer on a secure origin: over
  plain `http://` the page cannot open or use an account.
- Browser storage is per origin: each domain has its own accounts, records and filter. A customer
  of one domain keeps nothing on the other (Export and Import move an account between them).
- One relay serves every domain: it knows all the market's tokens.

## Showing only some assets (`?assets=`)

A link such as `https://<market>/?assets=twBTC,twUSDC` keeps that list in the browser's local data
(`night-market/v1/_global/settings/asset-filter`) and removes the parameter from the address bar;
from then on the site shows only those assets, everywhere tokens appear. The list only narrows
within the site's set: `?assets=all` goes back to the site's whole set, and a market token outside
it is named as "not available on this site" and never shown. A market shows only when both of its
assets are listed; no asset is special. Symbols match in any case; well-formed symbols the market
does not know yet stay in the list and are named in the note under the tabs, and a list with
nothing on this site shows the site's whole set. Anything waiting for the customer (a change coin
to record, a live offer) always shows. `?assets=all` or `?assets=`, **Show all assets** (under the
tabs, or in Local Data) and CLEAR ALL clear it; Export and Import carry it. It only changes what
the page shows: it is not a security setting, and the relay never sees it. The code is
`src/assets/`.

## The customer's own proof server (AA 00062)

When the relay runs with `CLIENT_PROVING=required` (its `GET /v1/config` `clientProving`), the four
k≥18 account circuits (making and taking offers, shielded and unshielded withdrawals including Bridge
out's first transaction, re-filing a change) are proven by the customer's own prover, the Night
Market prover package (`docker run … ghcr.io/midnight-experiments/solana-proof-server:…`). The code is
`src/prover/`:

- **Before anything is signed** for one of those actions, the page tests the saved prover (a pass of
  the last minute is reused); without a passing one it opens the popup: the owner's words, the
  command, the URL (`http://localhost:6300` by default), Test, and Continue once a Test passed.
  Closing it stops the action. Every other action never shows it.
- **While the relay waits** (its job's `clientProof`), the page fetches the key-less proof request,
  posts it to the prover's `/prove-circuit`, and sends the proof back; the progress window says
  "Proving on your prover…" with the elapsed time.
- **Local Data → Proof server (optional)**: the URL, Test and its last result, the command, Forget.
  The setting is the browser-wide record `night-market/v1/_global/settings/prover`: kept in this
  browser only, never in an Export (Import refuses it), removed by CLEAR ALL.
- **URLs**: `http://localhost:*`, `http://127.0.0.1:*` or `https://…`; an https prover sees the
  transaction's private details, so the page asks for a confirmation first. The browser's
  local-network permission is asked before a localhost call (Chrome ≥ 142, Firefox ≥ 153); Brave
  and Safari block localhost from an https site, and the page says so.
- **The Content-Security-Policy** needs `http://localhost:* http://127.0.0.1:* https:` in
  `connect-src` (`deploy/RUNBOOK.md` section 16).

The package's image reference is the one constant `PROVER_IMAGE` in `src/prover/constants.ts`.

## The Solana wallet (AA 00047 lane B2)

Connect lists every Solana wallet in the browser: Wallet Standard wallets that can sign Solana
messages (`solana:signMessage`), found through the standard's two window events without a
library, and Phantom's injected `window.phantom.solana` when Phantom did not register through the
standard (`src/wallet/solana-wallets.ts`). The wallet only ever signs messages, never a Solana
transaction, so it needs no SOL.

- **Every signature is checked the moment it comes back** (`src/wallet/solana-signature.ts`): with
  tweetnacl over exactly the bytes the page asked for and the connected key. One that verifies only
  over a Solana off-chain-message wrapping (`\xff"solana offchain"` ‖ …, v0, the short v0 header or
  v1, or the wallet's own `signedMessage`) is a **Ledger (hardware) account**, which v1 refuses: the
  page says "hardware (Ledger) accounts aren't supported yet" and ends the session. Any other
  mismatch is a bad signature. Neither is ever sent to the market.
- **What the wallet signs is readable text.** An account call signs Track A's F3 v3 message (the
  circuit renders the same bytes: the first line `Site: <label>`, whose `Site: ` the circuit fixes
  (questions Q36), then each amount's base units and full token id, the site's name and
  decimals marked as the site's label, an offer's expiry as a UTC date); the signing panel lists the
  same facts (`src/wallet/sign-facts.ts`), and the wallet is asked only when every one of them is a
  line of the exact bytes it would sign (`SignFactsMismatchError` otherwise, nothing signed); opening an account and claiming demo tokens sign lane B3's
  envelope, Track A's proof-of-key message. While the wallet's window is open, the page shows the
  same text and a fingerprint (the first 8 hex digits of its `Digest` or `Nonce` line)
  (`src/wallet/SigningPrompt.tsx`).
- **Errors** (`src/wallet/wallet-errors.ts`): a declined request (4001), a locked wallet (4100 /
  4900), no answer within `walletTimeoutSeconds` (config.json, default 120), a bad signature.
- **The seam** stays `src/wallet/`: `WalletContext.tsx` takes a `WalletAdapter`
  (`src/wallet/phantom-adapter.ts`), and every operation asks for signatures only through
  `ActionSigning` (`src/wallet/signing.ts`).

- **What the contract enforces is listed beside the text** (AA 00047 P9.S, questions Q25 B′;
  `src/wallet/sign-facts.ts`): every amount in base units with the token's full id, the site's name
  and decimals marked as the site's label, the recipient and the signed expiry.

The browser tests use a mock Phantom (`test/e2e/mock-phantom.ts`: tweetnacl in the test process,
Phantom's byte semantics, and modes for a Ledger account, a declined request, a locked wallet, no
answer and another key) against a mock relay that checks every signature as the relay does
(`test/e2e/mock-relay.ts`), and a mock public indexer (`test/e2e/mock-indexer.ts`).

## The account, read from the chain (AA 00047 P9.S)

The page reads the connected wallet's account from Midnight's public indexer itself
(`src/chain/indexer.ts`; `config.json` `overrides.midnight.indexerUrl` points it elsewhere), never
from the relay: the account's contract state, decoded in the page with the compiled account's
`ledger()`. Before any deposit, trade, withdrawal or sealed note it checks the account is the
market's own (the verifier keys pinned in this build, the maintenance authority retired), that its
ONE device is the connected wallet, and that it is sealed to this browser's key on this network; the
Portfolio says what it found (`src/chain/AccountCheckNotice.tsx`). The nonce, the device counter, the
inbox and the public balances come from the same read. A Content-Security-Policy must allow the
indexer in `connect-src` (`deploy/RUNBOOK.md` section 16).

Offers sign a real expiry (one hour; a take ten minutes) and can be cancelled ("Cancel offer": one
approval that moves the account's nonce, questions Q30); a withdrawal's change is computed in the page
(questions Q28 A).

## The Night Market design system

`src/design/` holds the market's look: a modern, dark consumer trading UI (AA 00047 P8.1, spec
FR-006b, questions Q20–Q22). Near-black navy surfaces in four elevation steps (`--bg #070b14`,
`--surface #0e1422`, `--surface-2 #141b2d`, `--surface-3 #1b2438`), ONE brand gradient (violet
`#8b5cf6` → cyan `#22d3ee`) on non-text parts only (the logo, progress bars, highlights, the wallet
avatar), violet → indigo primary buttons (white text ≥ 5.7:1 at both ends), buy green `#34d399`
and sell rose `#fb7185`, Inter (variable) for everything with tabular numerals for every amount,
12–20 px radii with subtle borders and glows, restrained motion (none under
`prefers-reduced-motion`), and no glass (no backdrop blur). The words are plain, everyday ones for
end users: no bank, custody or statement vocabulary.

The shell is wallet-first: the header carries the mark, the network, the sections (a pill nav on a
desktop, a tab bar at the bottom below 900 px) and **Connect Phantom**, which becomes the wallet's
pill (avatar, address, the account) with a menu (copy address, Portfolio, Local Data, Disconnect).
The sections keep their routes: Markets `#markets`, Trade `#trade`, Portfolio `#account`, Local Data
`#local` ("Your data" until AA 00062).

| File                        | What it holds                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`                | Colour, type, spacing and rule tokens as CSS custom properties. Every text pair is checked for WCAG AA by `test/design-contrast.test.ts`: change a colour there and run the tests. |
| `base.css`                  | Reset, headings, links, focus ring, utilities (`num`, `tabular`, `mono`, `break`, `eyebrow`, `muted`, `small`, `sr-only`, `wrap`), reduced motion.                                |
| `components.css`            | The styles behind the components below.                                                                                                                                             |
| `fonts.ts`                  | The self-hosted font (see below).                                                                                                                                                   |
| `Icon.tsx`, `Identity.tsx`  | Inline SVG icons and the logo mark; the wallet `Avatar`, `TokenIcon` and `PairIcon` (colours from a hash of the text, never the only cue).                                      |
| `Toast.tsx`, `Progress.tsx` | Toasts (`ToastProvider` once in the shell, `Toast` anywhere); `Skeleton`, `Spinner`, `ProgressBar`, `Stepper`.                                                                  |
| `index.ts`                  | Every component, imported as `from '../design/index.js'`.                                                                                                                           |

### Fonts: self-hosted, not a font CDN

The font is Inter, from the `@fontsource-variable/inter` package (one variable face, weights
100–900; SIL Open Font License 1.1; the licence text ships in `public/licenses/`), served from the
site's own origin. Loading them from `fonts.googleapis.com` would hand every visitor's IP address
to Google before they did anything (a German court found that to breach the GDPR, LG München I,
3 O 17493/20, 2022), while the market promises its servers keep nothing about the customer. It would
also break a strict CSP and the browser tests, which refuse any request that leaves the page's
origin. Each Unicode subset is its own face with a `unicode-range`, so the browser downloads only
the Latin one for the English UI, with `font-display: swap`; without it the page falls back to the
system sans, and `test/e2e/visual.spec.ts` checks that fallback.

### Adopting the design system (every page uses it; follow this for anything new)

Replace plain markup with the components and keep every `data-testid` where it is: the components
pass `data-*`, `id`, `role`, `aria-*` and event props straight through to their element.

**Page frame.** A section is `<section data-testid="section-…">`, then a `PageHead`:

```tsx
<section data-testid="section-trade">
  <PageHead
    eyebrow="Make and take offers"
    title="Trade"
    lede="Every trade is one token against another. Take an existing offer now, or place your own at your price."
  />
  <div className="trade-grid">…</div>
</section>
```

Headings: the masthead's "Night Market" is the page's `h1`, a page title is an `h2` (`PageHead`), and
a panel title an `h3` (`Panel`).

**Panels.** `Panel` (a card; `title`, `meta` on the right, `tone="quiet"` for a raised side card,
`as="form"`/`"aside"`/`"div"`), `Card` (a panel with the violet glow, for the one card that invites
an action). Two panels side by side: `<div className="form-grid">…</div>`. Beside Markets and
Trade, `PortfolioDock` (`src/account/`) docks the holdings panel from 1180 px and turns it into a
drawer below that, opened by `PortfolioToggle` in the page head.

**Forms.**

```tsx
<Panel as="form" title="New order" onSubmit={submit}>
  <Field label="Side">
    <Segmented label="Side" options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]}
               value={side} onChange={setSide} />
  </Field>
  <Field label="Quantity" htmlFor="tr-qty" hint="Largest single payment: 11.00 twUSDC">
    <UnitInput id="tr-qty" unit="twBTC" inputMode="decimal" value={qty} onChange={…} data-testid="order-quantity" />
  </Field>
  <Field label="Market" htmlFor="tr-pair"><Select id="tr-pair" …>…</Select></Field>
  <div className="legs">                         {/* the exact legs, as in the mockup */}
    <div className="leg"><span className="k">You pay</span><span className="v num">10.50 twUSDC</span></div>
    <div className="leg"><span className="k">You get</span><span className="v num">0.50 twBTC</span></div>
    <div className="foot">Paid with your twUSDC coin of 11.00; the change stays in your account.</div>
  </div>
  <ButtonRow stretch>
    <Button type="submit" data-testid="place-order">Place order</Button>
    <Button variant="secondary" onClick={takeBest}>Take best ask</Button>
  </ButtonRow>
</Panel>
```

Also: `TextInput`, `CopyField` (a value to copy whole, e.g. a deposit address), `KeyValueList`
(label / value lines), `Steps` + `Step` (numbered steps the customer drives in order).

**Buttons.** `Button` with `variant` `primary` (default, the violet → indigo gradient) /
`secondary` / `buy` / `sell` (the trade actions, dark text on green or rose) / `danger` / `link`,
and `size="small"` (32 px on a desktop, 44 px below 900 px or on a touch screen); `className`
`btn-block` for full width, `btn-lg` for the one big action. A link that looks like a button (the
Markets book's Buy and Sell): `ButtonLink href=… size="small" variant="buy"`.

**Money and prices.** `Money` formats exact BigInt base units with the token's decimals, grouped,
in tabular numerals, and keeps the raw value in `data-raw`:

```tsx
<Money raw={10_500_000n} decimals={6} unit="twUSDC" />   // 10.50 twUSDC
```

Prices from the book keep `bidText` / `askText` from `src/market/view.ts` (bids round down, asks
up), wrapped in `<span className="price-bid">` / `price-ask`.

**Tables.** A statement or history table stacks into label / value lines at 640 px and below;
give every non-first cell its column's `label`:

```tsx
<StatementTable caption="My offers" columns={[{ label: 'Placed' }, { label: 'Order' },
  { label: 'Quantity', align: 'right' }, { label: 'Price', sub: 'twUSDC', align: 'right' },
  { label: 'Status', align: 'right' }]}>
  {offers.map((o) => (
    <tr key={o.id} data-testid="my-offer" data-status={o.status}>
      <Cell block>{placedAt(o)}</Cell>
      <Cell label="Order">{o.side === 'sell' ? 'Sell' : 'Buy'} {o.base}</Cell>
      <Cell label="Quantity" align="right" num>{o.quantity}</Cell>
      <Cell label="Price" align="right" num>{o.price}</Cell>
      <Cell label="Status" align="right"><StatusPill status="live">Live</StatusPill></Cell>
    </tr>
  ))}
</StatementTable>
```

A value with a second line under it goes in one `<span className="num-wrap">value<Sub>second
line</Sub></span>`, so the phone layout keeps the line under the value. An order book is
`<StatementTable variant="book" …>`: it stays a compact table on a phone, with the Take button in
`<td className="act">`. A line the account cannot pay: the disabled small `Button`, in place,
wrapped in a `Tooltip` that says why on hover, keyboard focus and tap (no extra row):
`<Tooltip id="nt-…" text="Not enough twBTC. You hold 100.00 twBTC."><Button … disabled
aria-describedby="nt-…">Sell</Button></Tooltip>`. The wrapper is the focusable part, and `id` names
the visually hidden copy of the text the button's `aria-describedby` points to; the sentence
comes from `fundWithOneCoin` (`notEnoughText`). The account's own offer: `<YoursBadge />` ("Your
offer"). A holdings row: `AssetCell symbol="twBTC" name="Test-wrapped BTC" origin=…`; a subtotal:
`SubtotalRow` in `foot`.

**Badges and states.** `Badge tone="green|navy|grey|gold|red"` (a market's Active / Buyers only /
No offers yet), `StatusPill status="live|filled|cancelled|progress|refunded|failed|done|idle"` (an
offer's or job's state, with a dot), `NoValue` for a deliberately absent value ("no buyers", "no
trades yet"), `Skeleton` while a value loads, `NetworkBadge network="midnight"`.

**Messages.** What just happened (a result, or an error the customer caused) is a `Toast`
(`tone="success|error|info"`, `onClose`, `timerKey`): a success fades after 12 s, an error stays
until closed, and the toast keeps the page's `data-testid`. A standing explanation is a
`Notice tone="info|warning|danger|success" title="…"`. The one-live-offer rule (Q9):

```tsx
<Notice tone="warning" title="One live offer per account.">
  You already have one: Sell 0.50 twBTC at 60,000. Placing an order, taking an offer or
  withdrawing is a new signed action, and it cancels that offer. We ask you before it happens.
</Notice>
```

A confirmation before a signed action that cancels the live offer: `Dialog` (native `<dialog>`,
Escape closes it) with `actions={<><Button variant="secondary">Keep my offer</Button><Button>…</Button></>}`,
instead of `window.confirm`. A destructive action with a typed phrase: `TypedConfirmDialog` (as
Local Data's CLEAR ALL). Nothing to show: `EmptyState icon="…" title="…"`.

**Progress.** A signed action runs through the app's `ActivityStore` (`src/activity/`): the page
wraps it in `activity.run(kind, …)` and reports its relay jobs with `activity.job(job)` (its
`OperationEnv.onJob`). The signing modal (`src/wallet/SigningPrompt.tsx`) then shows the exact text
Phantom shows with its fingerprint while the wallet is open (`sign-prompt`), and after the signature
the action's steps, a bar and the relay's stage (`activity-progress`), with "Continue in background".
The steps depend on how the action ends (`ACTIVITY_FLOW` in `src/activity/activity.ts`):

- an on-chain action (open an account, demo tokens, a take, a withdrawal, saving a change): Approve →
  Market prepares it → Confirmed on Midnight, with a bar against the measured duration of that action;
- making an offer: Approve → Preparing your offer → Listed on the market. A made offer is a proven,
  signed intent the exchange lists; nothing is on-chain until someone takes it, and the tokens stay
  in the account until then. The bar covers the preparation (the proof) only, and the step ends when
  the exchange lists the offer. Every place that shows the account's own offers says so
  (`src/trade/messages.ts`, `OFFER_OFF_CHAIN`).

On the page,
`StageTracker` shows a long job (done stages ticked in green, the current one ringed in violet), and
`Hash` a transaction hash or id (shortened, with Copy, and a link when `href` is given). Pass a
stage's test attributes through `data`:

```tsx
<StageTracker label="Your take" stages={[
  { key: 'proved', title: 'Proved', state: 'done', time: '14:06',
    detail: <>Midnight tx <Hash value={txHash} /></>, data: { testid: 'trade-stage', stage: 'proved' } },
  { key: 'batcher', title: 'Sent to the exchange', state: 'current' },
  { key: 'settled', title: 'Settled', state: 'pending' },
]} />
```

**Check it.** `test/e2e/visual.spec.ts` screenshots every page at 1440 px, 768 px and 390 px and
asserts no horizontal page scroll, 44 px buttons on touch screens, the self-hosted font and no
glass; add the new page there (its fixtures are in `test/e2e/visual-fixtures.ts`). The screenshots
land in `test-results/visual/` (or `$VISUAL_OUT_DIR`). The design review screens (the landing,
Trade, Create offer, the signing modal approving, the make-offer progress (preparing, then listing)
and the listed offer, Portfolio, the drawer, demo tokens, an error toast) are
`test/e2e/screens.spec.ts`, in `test-results/screens/` (or `$SCREENS_OUT_DIR`). The contrast of
every text pair on the dark surfaces is `test/design-contrast.test.ts`; axe-core (WCAG 2.2 A/AA
rules) on the key screens, the drawer's focus trap, Escape on every overlay and the focus rings are
`test/e2e/a11y.spec.ts`.

## When something is not working (error states)

Every way the market, the exchange, the wallet or the browser can stop an action has one wording,
kept in one place and unit-tested (`test/errors.test.ts`; the walkthroughs in the browser are
`test/e2e/errors.spec.ts`):

| File | What it words |
| --- | --- |
| `src/relay/messages.ts` | The relay's refusals (rate limits with their wait, the fee wallet low or starting up, a stale or replayed signature) and failed jobs (the exchange's settlement service at its limit or failing). `RelayError.message` is already the customer's sentence. |
| `src/relay/status.ts` | What `/health` pauses: the market unreachable, its prover down, its fee wallet low or syncing (the shell); the settlement service down or refusing (Trade). `RelayStatus.tsx` reads `/health` every minute and on tab focus; pages disable what is paused and say why BEFORE the wallet is asked to sign. |
| `src/store/messages.ts` | Local storage blocked, unavailable or full. |
