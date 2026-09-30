# syntax=docker/dockerfile:1
# The key-volume job (deploy/compose.yml service `keys`): compactc 0.35.0 (the account) and 0.34.0
# (its declared callees, compile-time only), the pinned Passport sources, and the relay's
# dependencies (the Signet Compact module, compact-runtime 0.20.0 for the account module, and the
# verification's ledger-v9). It builds the relay's prover and verifier keys INTO A VOLUME at run
# time (deploy/key-volume/build.sh); the image itself carries no keys.
# Build from the repository root, with the vendor/passport submodule checked out:
#   docker build -f deploy/key-volume.Dockerfile .

ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

# The relay's production dependencies (the same lines as deploy/relay.Dockerfile, so the layer is shared).
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY relay/package.json relay/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production --ignore-scripts

# Both compilers from their release archives, each checked against the SHA-256 pinned in the script
# (and its --version line): 0.35.0 for the account, 0.34.0 for the vault and the Signet singleton.
FROM ${BUN_IMAGE} AS compactc
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-compactc.sh /tmp/fetch-compactc.sh
RUN COMPACTC_DIR=/opt/compactc-0.35.0 bash /tmp/fetch-compactc.sh 0.35.0 \
 && COMPACTC_DIR=/opt/compactc-0.34.0 bash /tmp/fetch-compactc.sh 0.34.0

FROM ${BUN_IMAGE}
ARG PASSPORT_COMMIT=451f7610e90000e0c5550877418122a04b85d0e6
ENV PASSPORT_COMMIT=${PASSPORT_COMMIT} \
    NODE_ENV=production \
    HOME=/tmp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=compactc /opt/compactc-0.35.0 /opt/compactc-0.35.0
COPY --from=compactc /opt/compactc-0.34.0 /opt/compactc-0.34.0
# zkir fetches the proving system's public parameters over HTTPS and needs the system CA bundle.
COPY --from=compactc /etc/ssl/certs /etc/ssl/certs
COPY package.json bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY relay/package.json relay/
COPY relay/src relay/src
# The Compact sources only (the account, its modules, the vault and the vendored singleton).
COPY vendor/passport/contract/contracts/account.compact vendor/passport/contract/contracts/
COPY vendor/passport/contract/contracts/modules vendor/passport/contract/contracts/modules
COPY vendor/passport/contract/contracts/erc20-vault/src/erc20-vault.compact vendor/passport/contract/contracts/erc20-vault/src/
COPY vendor/passport/contract/contracts/erc20-vault/src/vendor vendor/passport/contract/contracts/erc20-vault/src/vendor
# The arm's message builder (browser-safe: no compiled contract): the package root's Solana envelope
# scheme (packages/core/src/solana-auth.ts) imports it, and the key job imports the package root.
COPY vendor/passport/contract/src/wallet/ed25519-message.ts vendor/passport/contract/src/wallet/hex.ts vendor/passport/contract/src/wallet/
# The step that points the compiled account module at compact-runtime 0.20.0 (only it).
COPY scripts/pin-contract-runtime.mjs scripts/
COPY deploy/key-volume/build.sh /usr/local/bin/nightmarket-key-volume
# The mount points, owned by the unprivileged user: a new named volume takes this ownership.
RUN chmod 0755 /usr/local/bin/nightmarket-key-volume \
 && mkdir -p vendor/passport/contract/contracts/managed /zk-params \
 && chown bun:bun vendor/passport/contract/contracts/managed /zk-params
USER bun
ENTRYPOINT ["/usr/local/bin/nightmarket-key-volume"]
