# Night Market

A create-and-trade market on Midnight, controlled by Solana wallets. **A proof of concept on test
networks: nothing here carries real value.**

## What this is

A customer with only a Solana wallet (Phantom) can:

1. **Open an account.** Connect the wallet and open a Passport account on Midnight. The wallet's
   Ed25519 key is the account's key: it only signs messages, needs no SOL, and no Midnight wallet
   is needed. The market pays every Midnight fee.
2. **Get demo tokens.** The market's stagenet tokens are the native Midnight test tokens of
   [`effectstream/mint-test-tokens`](https://github.com/effectstream/mint-test-tokens) (twBTC,
   twETH, twUSDC, twUSDM).
3. **See the order books.** Each configured market is two tokens, any two: twBTC/twUSDC,
   twETH/twUSDC, twUSDM/twUSDC and twETH/twBTC by default. Prices come only from the live ZSwap
   offer book; a market with no live offers shows "no liquidity". No token is special.
4. **Make and take offers.** Trade one token for another by making an offer at a chosen price, or
   by taking an offer already in the book.
5. **Keep data in the browser.** Everything the market stores about a customer stays in the
   browser. A Local data tab shows it and offers Export, Import and Clear all.

Night Market is built from [MN Bank](https://github.com/acedward/passport-evm-dapp) (an EVM-wallet
bank on the same Passport accounts), with the EVM wallet, Sepolia and the bridge removed. Its
history is this repository's `main`.

## Status

Work in progress on the `00047-solana-night-market` branch (draft pull request into `main`):

| Step | What | State |
|---|---|---|
| B1 | Rebrand; remove Sepolia, EVM and the bridge; the mint-test-tokens registry; generic pairs | done |
| Track A | The Passport account's Ed25519 arm (`acedward/passport`, branch `00047-solana-ed25519-arm`) | done (draft PR acedward/passport#6) |
| B2 | Web: Phantom connect, account opening, the market UI, the signing screens | done (lane `00047-lane-web`) |
| B3 | Relay: Ed25519 actions (one wallet prompt each), both proof servers, key pins, the demo-token endpoint | done (lane `00047-lane-relay`) |
| P6 | Integration and stagenet acceptance | after A, B2, B3 |

The signing seams are `packages/core/src/signing.ts` (the device key and
signature types), `web/src/wallet/signing.ts` (`ActionSigning`, what the browser asks the wallet
to sign) and `relay/src/passport/arm.ts` (`DeviceArm`, the relay's check of a signed call).

## Architecture

- **Web app**: a static site. It connects the Solana wallet, holds the customer's records in local
  storage, and computes balances and prices in the browser.
- **Relay**: a stateless service. It proves each transaction and pays the Midnight fees from a
  sponsor wallet. It stores nothing about individual customers except which Solana keys have
  received their demo tokens (a small claims file, `deploy/RUNBOOK.md` section 7).
- **Network**: Midnight stagenet, a test network.

## How this branch works

`00047-solana-night-market` is the master branch of this project's single pull request into
`main`. Work is done on short-lived branches whose temporary pull requests target this branch, and
each is merged in with a merge commit once its checks are green. The master pull request stays a
draft until the work is complete.

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
| `tokens` | `{ "tokens": [{ "symbol", "decimals", "midnightColour", "name"? }] }`: tokens added to the network's built-in list (`"mode": "replace"` replaces it). |
| `pairs` | The markets, `["BASE/QUOTE", …]`; default: the network's pairs. |
| `assets` | This site's asset set (a list of symbols, or `"all"`); the page's `?assets=` link narrows within it. |
| `walletTimeoutSeconds` | How long the page waits for the Solana wallet to answer a connection or a signature (5–600; default 120). |

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
Every domain must be served over https.

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
