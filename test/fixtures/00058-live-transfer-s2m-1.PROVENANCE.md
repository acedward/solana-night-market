# `00058-live-transfer-s2m-1.json`

A REAL answer of 00058's bridge node to `GET /transfers/s2m:1` (an s2m lock to a contract that is not a
Passport account: `undeliverable`, `not-a-passport-account`), recorded by AA 00057's P3 run 1 on the local
journey stack with the real bridge node @ effectstream `1c9f4959db1a9f004820c01fb321225bb255916c`
(branch `00058-bridge-contract-delivery`):
`/Users/edwardalvarado/todo/AA/evidence/00057-solana-midnight-journey/p2/up1/node-x-transfer-s2m-1.json`,
copied byte for byte. The node wraps the view: `{ "transfer": TransferView }`
(`templates/solana-midnight-bridge/packages/node/api.ts`, `GET /transfers/:id`; the CLI reads it the same
way, `packages/cli/api-client.ts`). AA 00060 P10.3 C13: Night Market's reader did not unwrap it.
