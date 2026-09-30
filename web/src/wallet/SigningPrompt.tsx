// The page's side of a wallet signature (spec FR-003; AA 00047 lane B2): while the Solana wallet is
// asked to sign, this panel shows the exact text the wallet shows, with its fingerprint, so the
// customer can compare the two before approving. It holds nothing and cancels nothing: the wallet
// answers (or the page's timeout ends the wait), and the panel closes by itself.

import { useSyncExternalStore } from 'react';

import { Button, Dialog } from '../design/index.js';
import type { SignPromptStore } from './sign-prompt.js';

const LEDE = {
  'account-call':
    'Your wallet shows this text: it is exactly what you approve, and what your account checks before anything happens. Approve it only if it matches what you asked for.',
  'relay-envelope':
    'Your wallet asks you to prove you hold this key, so the market can act for you. This signature moves none of your funds.',
} as const;

export function SigningPrompt({ prompts, timeoutSeconds }: { prompts: SignPromptStore; timeoutSeconds: number }) {
  const prompt = useSyncExternalStore(prompts.subscribe, prompts.get, prompts.get);
  if (!prompt) return null;
  const digestLine = prompt.kind === 'account-call' ? 'Digest' : 'Nonce';
  return (
    <Dialog
      open
      title={`Approve in ${prompt.wallet}`}
      onClose={() => prompts.hide()}
      testId="sign-prompt"
      actions={
        <Button variant="secondary" onClick={() => prompts.hide()} data-testid="sign-prompt-hide">
          Hide this panel
        </Button>
      }
    >
      <p className="small" data-testid="sign-prompt-kind" data-kind={prompt.kind}>
        {LEDE[prompt.kind]}
      </p>
      <pre className="sign-text mono" data-testid="sign-prompt-text">
        {prompt.text}
      </pre>
      <p className="small">
        Fingerprint{' '}
        <strong className="mono" data-testid="sign-prompt-fingerprint">
          {prompt.fingerprint}
        </strong>
        : the first digits of the <span className="mono">{digestLine}</span> line in your wallet.
      </p>
      <p className="xsmall muted">
        Waiting for your wallet. Nothing is sent until you approve; if you close the wallet&apos;s window, the page
        stops waiting after {timeoutSeconds} seconds.
      </p>
    </Dialog>
  );
}
