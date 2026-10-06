# Night Market

A create-and-trade market on Midnight, controlled by Solana wallets. **A proof of concept on test
networks: nothing here carries real value.**

## What this is

A customer with only a Solana wallet (Phantom or Nightly) can:

1. **Open an account.** Connect the wallet and open a Passport account on Midnight. The wallet's
   Ed25519 key is the account's key: it only signs messages, needs no SOL, and no Midnight wallet
   is needed. The market pays every Midnight fee.
2. **Get demo tokens.** The market's stagenet tokens are the native Midnight test tokens of
   [`effectstream/mint-test-tokens`](https://github.com/effectstream/mint-test-tokens) (twBTC,
   twETH, twUSDC, twUSDM).
3. **See the order books.** Each configured market is two tokens, any two: twBTC/twUSDC,
   twETH/twUSDC, twUSDM/twUSDC and twETH/twBTC by default. Prices come only from the live ZSwap
   offer book; a market with no live offers shows "no liquidity". No token is special.
4. **Make and take offers.** Each market is one view, `Order book <base> ⇄ <quote>`, with amounts in
   the base and prices in the quote (the book says so under its title). Take a whole offer already in
   the book, or add your own at a chosen price from the create row that ends each half: "Sell
   <quote>" under Sellers (you buy the base; your offer is listed under Buyers) and "Sell <base>"
   under Buyers (listed under Sellers). Your own offer stays in the book, marked "Your offer", with
   the note "You can't take your own offer." and no action. Offers cannot be cancelled: each one
   ends at the expiry you approved (one hour), or sooner when your account approves anything else.
5. **Keep data in the browser.** Everything the market stores about a customer stays in the
   browser. A Local data tab shows it and offers Export, Import and Clear all.
6. **Bridge tokens between Solana and Midnight** (AA 00060, when the site is configured for it). The
   Portfolio shows each token's total and is a list of five actions, each opening its own page:
   1. **Send tokens to a Midnight wallet** (a withdrawal);
   2. **Bridge in from Solana: make your tokens private.** One Solana transaction locks an SPL token
      in its bridge, and the bridge delivers the same amount, privately, to the account;
   3. **Bridge out to Solana.** The tokens go back to the wallet as SPL, through a per-transfer
      landing key and two Midnight transactions the market proves and pays for;
   4. **Mint Midnight tokens** (the free demo pack);
   5. **Mint Solana tokens** (a test faucet for the bridged SPL tokens; no wallet prompt).

   **Show in my wallet** (beside the actions) lets Nightly show the account's Midnight tokens next to
   the wallet's Solana ones, through an RPC injector. Each bridged token (for example X and Y)
   shows its total, its private balance on Midnight and the wallet's SPL balance on Solana, with
   the mint address.

Night Market is built from [MN Bank](https://github.com/acedward/passport-evm-dapp) (an EVM-wallet
bank on the same Passport accounts), with the EVM wallet, Sepolia and the bridge removed. Its
history is this repository's `main`.

## Status

A proof of concept on Midnight stagenet, on the `00047-solana-night-market` branch (pull request
into `main`, ready for review). Its limits are listed under [Known limitations](#known-limitations).

| Step | What | State |
|---|---|---|
| B1 | Rebrand; remove Sepolia, EVM and the bridge; the mint-test-tokens registry; generic pairs | done |
| Track A | The Passport account's Ed25519 arm (`acedward/passport`, branch `00047-solana-ed25519-arm`) | done (draft PR acedward/passport#6) |
| B2 | Web: Phantom connect, account opening, the market UI, the signing screens | done (lane `00047-lane-web`) |
| B3 | Relay: Ed25519 actions (one wallet prompt each), both proof servers, key pins, the demo-token endpoint | done (lane `00047-lane-relay`) |
| P6 | Integration and stagenet acceptance: two accounts on a localnet and on stagenet (open, demo tokens, a make listed on the staging kernel, a take settled by the staging batcher, a withdrawal), a tampered proof refused by the node (`test/stack/p6/`) | done |
| P8 | The end-user dark design | done |
| P9–P11 | Security review rounds and their fix passes: the wallet's readable text is what the circuit enforces; the browser checks every account and decodes its coins and fills itself; the relay is bounded per account and per day | done; what remains is under [Known limitations](#known-limitations) |
| P11.I | The stagenet re-acceptance with the current keys (`21493588…`): two new accounts opened and checked by the page, demo tokens, a make listed on the staging kernel, a take settled by the staging batcher and shown "Filled" by the page's own decode of the swap, a shielded and an unshielded withdrawal, a cancel, and the relay's refusals | done (2026-10-02) |
| AA 00060 | Bridge in and Bridge out between Solana and Midnight (one bridge per SPL mint, the 00058 bridge node), Show in my wallet (the 00059 RPC injector), Nightly, the Portfolio's action list with totals, Mint Solana tokens, and the one-view trade page. Offers can no longer be cancelled. Tested on a local stack with the real bridge nodes and injector, and by the owner in Nightly by hand; security review PASS WITH FINDINGS | done on `00060-night-market-bridge-wallet` ([PR #22](https://github.com/acedward/solana-night-market/pull/22) into this branch, ready for review) |

The signing seams are `packages/core/src/signing.ts` (the device key and
signature types), `web/src/wallet/signing.ts` (`ActionSigning`, what the browser asks the wallet
to sign) and `relay/src/passport/arm.ts` (`DeviceArm`, the relay's check of a signed call).

## Architecture

- **Web app**: a static site. It connects the Solana wallet, holds the customer's records in local
  storage, and computes balances and prices in the browser.
- **Relay**: a stateless service. It proves each transaction and pays the Midnight fees from a
  sponsor wallet. It stores nothing about individual customers except which Solana keys have
  received their demo tokens (a small claims file, `deploy/RUNBOOK.md` section 7). It is not
  trusted for state: the web app reads each account from Midnight's public indexer itself,
  refuses one that is not the market's own or has any device besides the connected wallet, and
  decodes the account's coins and fills itself (`deploy/RUNBOOK.md` section 16).
- **Network**: Midnight stagenet, a test network.
- **Bridging** (AA 00060, only when configured): one bridge per SPL mint (the 00058 bridge: a Solana
  program, a Midnight contract and a bridge node), listed in a **journey registry** the site and the
  relay share. The site talks to Solana through its own Solana RPC (Bridge in's lock, balances), to
  each bridge node's API (a transfer's progress, its deployment record), and to the RPC injector
  for Show in my wallet. The relay additionally proves and pays Bridge out's second transaction, and
  can run the test SPL faucet. `deploy/RUNBOOK.md` section 17.

## Known limitations

Night Market is a proof of concept on Midnight stagenet, a test network. It trades only free
faucet test tokens, which have no value. These limits remain. The site has no About page (AA 00060
FR-029): this list and `deploy/RUNBOOK.md` are where they are written down, and the page's own
warnings (the signing panels, the landing-key text, the Bridge out and Show in my wallet notices)
stay in the flows they apply to.

**Accounts**

- **A new account refused at opening stays refused, and that wallet cannot open another account on
  this site.** The page checks every new account before anything is signed for it, and keeps a
  refusal. Anyone can cause one by depositing into the account in the few blocks (about 3) between
  its deploy and the retirement of its setup key; so can an honest relay that retires the key more
  than 100 blocks after the deploy (a relay restarted between its two deploy steps, for example).
  Nothing is lost: the account holds nothing yet. (Audit R4-6; questions Q42, Q51.)
- **A page that proves and pays for itself can change the account's encryption key with one
  approval.** The wallet then reads "Rotate encryption key". The market's relay only lands a change
  back to the key the account was opened with, so such a page must prove and pay the transaction
  itself. If it does, it can read the sealed notes filed after the change (privacy); it cannot move
  funds, and the site offers to restore the browser's key. (R3-9; questions Q50.)
- One live offer per account, and one coin per payment (coins are not merged).
- **You cannot take your own offer.** The offer and the take would be signed at the same auth nonce
  and device counter, so whichever runs second in the one settling transaction fails. Your own
  offer's row says so and has no action. (AA 00060 FR-027 as amended; questions Q9 there.)
- **Offers cannot be cancelled; they expire.** An offer ends at the expiry you approved (one hour),
  or sooner when your account approves anything else (a take, a withdrawal, a Bridge out, saving a
  change or restoring your key; the page asks first). A future Offer Files feature will provide
  cancellation for every client. (AA 00060 FR-028; this replaces 00047's "Cancel offer".)
- All of a customer's data is in their browser; Export is the only backup. Export on Your data
  after every change: clearing the browser without an export loses the key that finds the
  account's coins.
- Ledger-backed Phantom accounts are refused (they sign a wrapped message).
- **Solana wallets:** Phantom and Nightly are tested. Any other wallet that signs Solana messages
  through the Wallet Standard may work. The page asks the wallet for one approval at a time, with a
  short pause between approvals; if no window appears, open the wallet from the browser's toolbar.

**What the page trusts**

- **A withdrawal's recipient encryption key is not signed.** The one approval binds the recipient,
  the token and the amount, but not the key the recipient's wallet uses to find the coin. A
  dishonest relay could hide a withdrawn coin from the recipient's wallet scan; it cannot redirect
  or spend it. This is the one accepted exception to the trustless relay. (Questions Q28.)
- **The public indexer is trusted to serve the chain faithfully.** The page reads and decodes the
  account from Midnight's public indexer itself and checks what it can (each transaction's hash,
  each coin's place in its transaction), but it is not a light client: it does not check the
  indexer against block headers.
- **Histories over 500 actions** are read past the indexer's first page through its WebSocket
  subscription. That path runs live with small pages and is tested with recorded histories of up
  to 1,800 actions, not with a live account past 500. (Questions Q56.)

**The relay and the sponsor**

- **A replay window for the relay's own sign-in message.** Opening an account and claiming demo
  tokens use a one-time sign-in message. The relay remembers up to `AUTH_MAX_USED_NONCES`
  (200,000) used nonces; past that it forgets the oldest, and a captured signed message could be
  accepted again until its own expiry (at most 10 minutes). Only its signer holds it (it travels
  over TLS), it moves no funds, and every cap still applies. (Questions Q40.)
- **Sponsor costs.** The market pays every fee. The per-account caps (one job at a time, offers,
  makes, cancels, key restores, 100 withdrawals a day) bound what one account costs; many accounts
  are bounded only by the registration caps (100 new accounts a day, 3 per client address) and the
  one prover lane. The caps and counters live in memory and reset when the relay restarts.
  (Questions Q37, Q49; `deploy/RUNBOOK.md` section 9.)
- **One prover for the whole market.** Every action waits its turn on one proof server. Takes go
  first, then makes, and a take or make the queue cannot start before its signed expiry is refused
  at once (`prover-busy`). Withdrawals, cancels and the other actions wait behind at most one job of
  each other account (the least recent users first), so a flood from many accounts can delay them
  by minutes, never stop them; after the exchange's settlement service answers HTTP 429 (its daily
  cap), takes pause for 5 minutes (`exchange-busy`). (Audit R4-1, R4-3; questions Q59, Q61;
  `deploy/RUNBOOK.md` section 9.)
- **A crowd of takes can make the market answer "busy".** Among takes, the accounts that used the
  prover least in the last hour go first. So a crowd of takes from fresh accounts (about 15 waiting at
  once) gets a customer's take refused at once (`prover-busy`): nothing is sent or charged, and the
  customer tries again shortly. Each take in such a crowd needs a funded account, a live offer and a
  coin, and refused ones count toward that account's daily limits; keeping it up takes about 80
  accounts in rotation. (Audit R4b-2.)
- **The exchange's daily allowance is shared.** The staging exchange's settlement service (its
  batcher) settles a limited number of takes a day (1,000) for all its clients together, and anyone
  can call it directly, not only this market. Once it is used up, takes pause market-wide
  (`exchange-busy`) until it resets; making offers, cancelling and withdrawing keep working. Only the
  exchange's operator can change this. (Audit R4b-4; issue 00055.)
- **An offer that can never settle.** A maker can list an offer that asks to be paid a coin its own
  account has already received (the `want-reused` check covers takes only). No take of that offer
  can settle, and each taker who tries it uses one of their 10 daily unsettled-take tries and one of
  the exchange's settlements. The make caps (20 a day) bound how many such offers one account can
  list, and no funds are at risk. (Audit R4c-1.)
- **A rare race can mislabel a take.** When an account's own offer is filled at the same moment as
  one of its own takes (the same coin and the same wanted coin), the relay may report the take as
  settled. Only the label is wrong: the account really received the coin. The page never makes such
  a pair. (Audit R4c-2.)
- **The `via-sponsor` demo-token path** (not the default; `direct` is): a delivery resumed after a
  failure deposits from the sponsor's pooled balance of that token, so it can take a coin minted
  for another pending claim, which is then held back for the operator. (Audit R4-7.)
- **Proof-server memory.** The 9.0.0-rc.8 contract prover's memory grows across proofs. Run it
  with a 14 GB cap and restart it periodically while no proof runs (`deploy/RUNBOOK.md` sections 2
  and 12.1). A proof cut off fails its job, and the customer is not charged for it. In the AA 00060
  owner session, a 12 GiB cap was reached after several proofs; give it a restart policy too.

**Bridging (AA 00060)**

- **The market's prover sees one transfer's key while it proves Bridge out's lock.** It could take
  that one coin while it is in transit. Each transfer has its own landing key, so nothing else is
  exposed. (00060 Q2 A.)
- **The landing-key text is a key, and it is permanent for this site, network and wallet.** The
  same text gives the same key every time, so anyone who gets that signature can take the tokens of
  any Bridge out from this wallet on this site while they are in transit, now and later. Sign it
  only on this site; the text names the site's origin. (Q3 A.)
- **The landing key belongs to this site's origin.** The same wallet on another origin derives
  another key.
- **One coin per Bridge out:** the most you can send at once is your largest coin. A Bridge out that
  sends only part of a coin asks for one more approval, to save the change in your inbox (FR-021).
- **Wallets that sign the same text differently each time** (MPC, hedged signers) cannot bridge
  out. They are refused before anything moves. A wallet that changes its signer later derives
  another landing key: a browser that stored the key's check refuses with `landing-key-changed`,
  and a fresh browser silently finds nothing. Either way, a coin in transit then waits until the
  old signature can be reproduced.
- **The market remembers every landing coin it has locked or returned**, permanently, and refuses
  to re-issue an entitlement for one. A second transaction that fails after the market proved it
  can be sent again at most 3 times a day. A lock that lands after the market's 180 s wait is
  reported as not landed (the tokens still arrive on Solana), and Finish then fails because the coin
  is gone; the market watches for up to an hour more and then records the coin spent. That watch is
  one attempt in memory: if it is lost, the coin can cost the market up to 3 failing proofs a day.
- **"Find my transfers" needs a partial withdrawal's change to be in the inbox** (or this browser's
  own record) to find that transfer from the chain alone.
- **Finding a landing coin reads every Zswap event of the chain, on every attempt.** On stagenet on
  2026-10-05 that was 8,551 events (3.26 MB), downloaded in 3.2 s, and about 17 s of replay
  (estimated from local runs; a browser may be slower). It grows with the chain: on a much longer
  chain, Finish, Return and Find my transfers can become very slow or run out of memory, and the
  tokens then wait at the landing key. The keys can still be derived. (Follow-up: 00060 Q6.)
- **A Bridge in whose wallet answer was lost says "checking Solana"**, never "nothing was locked",
  and blocks another Bridge in of that token until Solana answers definitely. After the request has
  expired you may stop checking: the page shows what to look for in your wallet and warns that the
  first lock may still have landed, so bridging in again would be a second transfer with a second
  fee (both arrive in your account).
- **The site's Solana RPC is trusted to report transactions, history and statuses honestly; a
  forged or malformed answer can make the page wrongly say nothing was locked, and the customer may
  lock a second time into their own account.** The page also needs the RPC to honour
  `minContextSlot`. Kept as follow-ups: verify each returned transaction's signature over its
  message; require well-ordered history slots; validate a status's error shape. (Audit F2–F4,
  E5; 00060 Q8 B.)
- **Bridge in needs each bridge to prove its deployment.** Before every lock the page reads the
  bridge's `GET /deployment`; if it does not answer, or names another mint, program, contract,
  colour or decimals than the site's token list, Bridge in of that token is refused.
- **Nightly joins the lines of the text it shows**, so a site label could read as part of the
  circuit's words; the risk comes from other, hostile sites asking your wallet to sign for your
  account. Read the amounts in base units and the token ids, which stay visible. A fixed delimiter
  in Passport's renderer would fix it (a circuit change; the owner's decision). **Nightly loads a
  new token's name only when it is reopened**: after Show in my wallet, close and reopen Nightly to
  see the names.

The question and audit numbers refer to the project's planning records.

## How this branch works

`00047-solana-night-market` is the master branch of this project's single pull request into
`main`. Work is done on short-lived branches whose temporary pull requests target this branch, and
each is merged in with a merge commit once its checks are green. The master pull request is ready
for review. It merges after the Passport arm: acedward/passport#4, then #6, then `vendor/passport`
is re-pinned here.

AA 00060 works the same way one level down: `00060-night-market-bridge-wallet` is the master branch
of [PR #22](https://github.com/acedward/solana-night-market/pull/22) into `00047-solana-night-market`,
and its lanes merge into it.

## Repository layout

| Path | What it holds |
|---|---|
| `packages/core` | Shared, environment-neutral TypeScript: network profiles, the token registry (built from the vendored mint-test-tokens registry), the market pairs, amount maths, the relay's action envelope and API types, and the browser-safe Passport client surface (`@nightmarket/core/passport`). |
| `relay/` | The relay service (Bun + Hono). |
| `web/` | The web app (Vite + React). |
| `deploy/` | Compose files, Dockerfiles, `.env.example` and the runbook. |
| `docs/` | Reference notes: `PERFORMANCE.md` (MN Bank's proof times and DUST per action). |
| `scripts/` | The contract light compile, the Docker check runner and the secret scan. |
| `test/` | Browser end-to-end tests (Playwright) and the take gate's offline half. |
| `vendor/passport` | A git submodule: [`acedward/passport`](https://github.com/acedward/passport), pinned to the Ed25519 arm's branch `00047-solana-ed25519-arm`. The account contract and its client (the Solana device, its readable messages and checks) come from here. |

## Configuration

The site reads `config.json` next to `index.html` (`web/public/config.json`):

| Key | Meaning |
|---|---|
| `network` | `stagenet` (default) or `undeployed` (a local stack). |
| `relayUrl` | The relay's base URL as the browser sees it. |
| `tokens` | `{ "tokens": [{ "symbol", "decimals", "midnightColour", "name"?, "icon"? }] }`: tokens added to the network's built-in list (`"mode": "replace"` replaces it). `icon` is an image on the site's own origin (`token-icons/x-midnight.png`; the site bundles the wallet's test-token set in `web/public/token-icons/`); without one, the token shows its text badge. |
| `pairs` | The markets, `["BASE/QUOTE", …]`; default: the network's pairs. |
| `assets` | This site's asset set (a list of symbols, or `"all"`); the page's `?assets=` link narrows within it. |
| `walletTimeoutSeconds` | How long the page waits for the Solana wallet to answer a connection or a signature (5–600; default 120). |
| `solana` | AA 00060: the site's Solana RPC, `{ "rpcUrl", "cluster", "genesisHash"? }`; `cluster` is the Wallet Standard chain (`solana:devnet`, `solana:localnet`, …). Bridge in and every Solana balance read use it, never the injector. |
| `bridges` | AA 00060: the journey registry (I-1) this site bridges, as `scripts/bridge-tokens.ts` writes it: each token's colour, SPL mint, bridge program, bridge contract, bridge API, name, symbol, decimals and optional `icon`. Absent: no bridging. |
| `injector` | AA 00060: `{ "url" }` of the RPC injector that Show in my wallet registers with. Absent: no Show in my wallet. |

One build and one relay can serve several domains, each with its own `config.json`
([`web/README.md`](web/README.md)).

## Development

Requirements: Bun 1.3.11 and Node 24 (for the test runner), or Docker only.

```sh
git submodule update --init          # the pinned Passport sources
bun install
bun run contracts                    # compile the Passport contracts' JavaScript (no proving keys)
bun run check                        # format, lint, typecheck, unit tests
bun run build:web
```

`bun run contracts` downloads the pinned Compact compilers into `.tools/` and checks each release
archive's SHA-256 first: 0.35.0 (`--feature-zkir-v3`) for the account, whose Ed25519 arm needs its
`ed25519Verify`, and 0.34.0 for the vault and Signet contracts the account declares (compile-time
inputs only). It builds JavaScript and type declarations only, never proving keys, and points the
compiled account module at compact-runtime 0.20.0 (`scripts/pin-contract-runtime.mjs`): that module
alone uses 0.20.0, through the `@midnight-ntwrk/compact-runtime-0.20` alias; the relay's Midnight
SDK keeps 0.19.0.

To run everything in Docker instead (`node_modules` stays in a Docker volume):

```sh
scripts/docker-check.sh all          # install, compile, check, build, browser tests
scripts/docker-check.sh down         # remove the container and volumes
```

## Deployment

`deploy/compose.yml` is the deployment bundle for stagenet: a one-shot job that builds and
verifies the relay's proving keys, two proof servers (9.0.0-rc.8 for the account's circuits,
9.0.0-rc.6 for the sponsor wallet's DUST, until stagenet moves to dust/10), the relay and the web
site.
[`deploy/.env.example`](deploy/.env.example) documents every setting (including the pinned key-set
fingerprint and the demo-token endpoint). The operator's runbook is
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md); a host without Docker, [`deploy/SYSTEMD.md`](deploy/SYSTEMD.md).
Every domain must be served over https. Before a production deployment, go through the
[production checklist](deploy/RUNBOOK.md#production-checklist) at the top of the runbook.
Bridging (AA 00060) is optional and set up in [section 17](deploy/RUNBOOK.md#17-bridging-and-the-solana-side-aa-00060).

### Breaking changes in AA 00060

For deployments:
- With `BRIDGE_REGISTRY_FILE` set, the relay needs `RELAY_DATA_DIR`: it refuses to start without it.
  It also refuses to start (exit 78) when the key volume's bridge module or its ledger decoder does
  not load. Without `BRIDGE_REGISTRY_FILE` nothing changes.
- New settings, all optional: `BRIDGE_REGISTRY_FILE`, `RATE_LIMIT_UNAUTHENTICATED_PER_MIN`
  (default 6), and the test faucet's `SPL_FAUCET_*` (off unless `SPL_FAUCET_KEYS_FILE` is set).
  `CANCELS_PER_ACCOUNT_PER_DAY` is no longer used: offers cannot be cancelled.
- Relay API:
  - `cancel-offers` is refused with `403 offers-cannot-be-cancelled`, and so is a `restore-enc-key`
    to the account's own key.
  - `bridge-out` refuses `proven: true` and needs the new `spend` field; `bridge-out-entitle` can
    answer `503 busy`.
  - New: `GET /v1/spl-faucet` and the unsigned `spl-faucet` action.

For scripts that drive the page:
- The Portfolio's forms moved into sub-pages, `#account?action=<id>`, with "All actions" to go back.
  "Get demo tokens" is now the Portfolio's "Mint Midnight tokens" only.
- On the Trade page, `buy-best-ask`, `sell-best-bid`, `take-section` and the Side control are gone:
  the best offer is the first `take-line` of `trade-book-asks` / `trade-book-bids`.
- `cancel-offer` (the banner's Cancel offer), `own-offer-cancel`, `own-offer-confirm`,
  `own-offer-cancel-sign` and `own-offer-warning` are gone. An own row has `own-offer` and
  `own-offer-note`.
- A bridged token's row in the compact "Your tokens" list has `data-kind="bridged"`, and its value is
  the total.
- The About page is gone (FR-029): `/#about` opens Markets, like any unknown route, and
  `about-link`, `about`, `about-testnet`, `about-how`, `about-limits` and `about-limit` are gone.

## Checks and the secret scan

CI (`.github/workflows/ci.yml`) runs on every push and pull request: typecheck, lint, format,
unit tests, the web build, a relay start-up check under Bun, the Playwright smoke, a keyless
relay image build, and the secret scan over the full history.

This repository is public. Run the secret scan before every push:

```sh
SECRET_SCAN_FILES=/path/to/secret-file:/path/to/another bash scripts/secret-scan.sh
```

It runs gitleaks (the default rules plus wallet-secret, mnemonic, keyed-RPC-URL and
labelled-private-key rules, each proven by a self-test on random fakes) over the whole history
and the working tree. With `SECRET_SCAN_FILES`, it also reads those files in-process and checks
that no 3-word window of a mnemonic and no key's hex appears anywhere in the tree or the
history. It never prints a secret.

## License

Apache-2.0 ([`LICENSE`](LICENSE)).
