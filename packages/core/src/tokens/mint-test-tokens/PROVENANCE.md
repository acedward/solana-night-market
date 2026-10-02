# Vendored token registry

`metadata.stagenet.json` is copied **byte for byte** from
[`effectstream/mint-test-tokens`](https://github.com/effectstream/mint-test-tokens), the native
Midnight test-token faucets and their canonical registry. The market's stagenet token list is
built from it (`../registry.ts`). Do not edit it by hand: re-vendor it from a newer commit and
update this table.

| File | Upstream path | Commit | Git blob | SHA-256 |
|---|---|---|---|---|
| `metadata.stagenet.json` | `metadata/metadata.stagenet.json` | `a51cf3ad46520d1ded938fb86db8b7b99373ce56` | `b03d28108538d1c43508e4fdad769da392faba69` | `973977bc0dbf7eae6afd4b1d92f365326b2b69d257f3597cdaffa9dac34839d0` |

Vendored 2026-09-30 (AA 00047, lane B1). The file's own `registryRevision` is
`59041d2fd2acfdad53e437e5a4d2ba88a6f24e4f9e55869b66f465f3da11a0d1`, the revision the upstream
README lists as stagenet's ("ready; six verified active deployment identities").
`test/tokens.test.ts` re-checks the SHA-256.

## What the registry takes from it

For each of the six tokens, from its **active** deployment (`activeDeploymentId`, status `active`):

| Symbol | Name | Decimals | Privacy | Issuer contract | Token type (colour, `tokenId`) |
|---|---|---|---|---|---|
| twBTC | Test-wrapped BTC | 8 | shielded | `a112d24a…091a` | `ad2ba014…2e8e` |
| twETH | Test-wrapped ETH | 18 | shielded | `a9ea4f52…cd34` | `2862f0f3…477a` |
| twUSDC | Test-wrapped USDC | 6 | shielded | `11e406f1…0ec6` | `e934b965…2c9f` |
| twUSDM | Test-wrapped USDM | 6 | shielded | `6f6dacef…fede` | `723e4cac…8a87` |
| utwUSDC | Unshielded-test-wrapped USDC | 6 | unshielded | `473e8354…691e` | `a9e63fe9…926d` |
| utwBTC | Unshielded-test-wrapped BTC | 8 | unshielded | `2e962ef4…b59e` | `84392e97…e575` |

- `tokenId` is the token's raw type, `rawTokenType(domainSeparator, contractAddress)` (upstream
  `contracts/v2/deploy.ts`), which is the colour a coin of the token carries and the colour the
  exchange's offers name.
- `domainSeparator` (`mint-test-tokens:<symbol>`) and the issuer contract are kept for the
  demo-token endpoint (plan lane B3): each issuer has a permissionless
  `mint(recipient, amount, nonce)`.
- The registry's `faucet` presets (the site's suggested amounts) are not used: the market's
  demo pack is its own configuration.

No token is special: the market's pairs are a configured list (`../pairs.ts`), and nothing in the
code refers to any of these symbols.
