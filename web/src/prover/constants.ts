// AA 00062 (spec FR-005–FR-013; plan I-62a, I-62b): the page's side of "bring your own ZK prover".
// The pins, the four k>=18 circuits the market can hand to the customer's own prover, and the ONE
// place the package's image reference lives (plan P6.3 pins its digest here, and only here).

/** The four k>=18 account circuits a relay in `CLIENT_PROVING=required` hands to the page (I-62a). */
export const CLIENT_CIRCUITS = [
  'append_inbox_with_ed25519',
  'open_swap_shielded_with_ed25519',
  'withdraw_shielded_with_ed25519',
  'withdraw_unshielded_with_ed25519',
] as const;
export type ClientCircuit = (typeof CLIENT_CIRCUITS)[number];

export const isClientCircuit = (c: string): c is ClientCircuit => (CLIENT_CIRCUITS as readonly string[]).includes(c);

/** Which circuit each k>=18 action proves (spec Background table). Bridge out's first transaction is a
 *  shielded withdrawal, and its change is filed by `append_inbox_with_ed25519`. */
export const ACTION_CIRCUIT = {
  'open-swap': 'open_swap_shielded_with_ed25519',
  take: 'open_swap_shielded_with_ed25519',
  withdraw: 'withdraw_shielded_with_ed25519',
  'withdraw-unshielded': 'withdraw_unshielded_with_ed25519',
  'append-inbox': 'append_inbox_with_ed25519',
} as const satisfies Record<string, ClientCircuit>;

/** The pins this build was made for (I-62a "Pins"). A relay that advertises its own values in
 *  `/v1/config` `clientProving` wins: it is the one that receives the proof. */
export const PINNED_PROOF_SERVER = '9.0.0-rc.8';
export const PINNED_KEY_SET = '21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e';

/** The package's image. **Plan P6.3 replaces `<pending>` with the published digest, here only.** */
export const PROVER_IMAGE = 'ghcr.io/midnight-experiments/solana-proof-server:<pending>';

/** The default URL: the package published on this machine's loopback (I-62b). */
export const DEFAULT_PROVER_URL = 'http://localhost:6300';

/** The one-line command that starts the package (spec FR-007: the pinned image and a memory hint). */
export const PROVER_COMMAND = `docker run --rm -p 127.0.0.1:6300:6300 --memory 12g ${PROVER_IMAGE}`;

/** About how much memory one k>=18 proof needs (plan P0.6 point 7: a 9.4 GiB peak, 12 GiB cap). */
export const PROVER_MEMORY_GB = 12;

/** I-62b timeouts: `/version` answers within 5 s; `/prove-circuit` runs until the I-62a deadline. */
export const VERSION_TIMEOUT_MS = 5_000;
/** The time kept, before the hand-off's deadline, to send the proof to the market. */
export const POST_MARGIN_MS = 3_000;
/** A passing Test is reused, without asking the prover again, for this long (two k>=18 calls of one
 *  action: a withdrawal and its change, or Bridge out's withdrawal). */
export const RECENT_PASS_MS = 60_000;
/** The page's own bounds on what it relays (I-62a: 64 KiB of bytes, as standard base64). */
export const MAX_BASE64_CHARS = Math.ceil((64 * 1024) / 3) * 4;
