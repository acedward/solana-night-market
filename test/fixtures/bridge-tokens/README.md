# Generator goldens (AA 00060 P4.4)

`scripts/bridge-tokens.ts ../journey-registry.undeployed.json --site-config site-config.in.json
--relay-tokens relay-tokens.in.json --pairs X/Y,X/twUSDC --mode extend` must write exactly
`site-config.out.json` and `relay-tokens.out.json` (packages/core/test/bridge-token-lists.test.ts, T4.1).
