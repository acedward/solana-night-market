# Fixtures of the journey registry generator (AA 00057 P1)

`standin-x.record.json` and `standin-y.record.json` are two REAL deployment records (I-3 (c),
`effectstream.solana-midnight-bridge.deployment/1`), copied byte for byte from AA 00060's P9 run 3
(`evidence/00060-night-market-bridge-wallet/p9/run3/`, 2026-10-05). They were written by 00058's
`bun run bridge:record --mode live --api http://bridge-<x|y>:9999 --name <X|Y> --symbol <X|Y>`
(effectstream `00058-bridge-contract-delivery` @ `1c9f4959db1a9f004820c01fb321225bb255916c`) against a
local `solana-test-validator` and a Midnight `undeployed` localnet, after the tool had checked each
colour against the bridge contract's own `tokenColor` and the chain. They hold public values only
(mints, programs, contracts, colours, the operators' PUBLIC keys); the stack they describe is gone.

| File | sha256 |
|---|---|
| `standin-x.record.json` | `4029f474cf9bb54c14327014372a7188852c461cf1cc9675accc67fd97096b8c` |
| `standin-y.record.json` | `9106e4c31e97efe461ed02a77f80e24b9a9e893aada2e3a5f4fbe2bf385633d4` |
