// "Restore my encryption key", explained BEFORE Phantom opens (AA 00047 P11, audit round 3 R3-9 /
// F-A3-5). The wallet's own text for a restore is the same as for any key change ("Rotate encryption
// key" / "New key <16 hex>"), so a phishing page could ask for one too. This dialog says, in plain
// words, what this site's restore does: it sets the account's key back to the one it was OPENED with,
// which is the one THIS browser holds (the page's origin check proves the two equal, and the relay
// lands no other key: P11.R, questions Q50), it never moves funds, and the wallet must show exactly
// that key. Only "Continue to Phantom" asks the wallet.

import { Button, Dialog } from '../design/index.js';
import { useWalletName } from '../wallet/WalletContext.js';

/** The first 16 hex digits of a key: what the wallet shows after "New key". */
export const keyFingerprint = (key: string) => key.replace(/^0x/, '').toLowerCase().slice(0, 16);

export function RestoreKeyDialog({
  open,
  browserKey,
  onContinue,
  onCancel,
}: {
  open: boolean;
  /** This browser's encryption public key (64 hex): the key the restore puts back. */
  browserKey: string;
  onContinue(): void;
  onCancel(): void;
}) {
  const fp = keyFingerprint(browserKey);
  const wallet = useWalletName();
  return (
    <Dialog
      open={open}
      title="Restore your encryption key?"
      onClose={onCancel}
      testId="restore-explain"
      actions={
        <>
          <Button variant="secondary" data-testid="restore-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button data-testid="restore-continue" onClick={onContinue}>
            Continue to {wallet.name}
          </Button>
        </>
      }
    >
      <p data-testid="restore-explain-what">
        Your account on Midnight is no longer set to this browser&apos;s encryption key, so notes about coins sent to it
        would not be readable here. Restoring sets it back to the key your account was opened with, which is the one
        this browser holds. The market puts back no other key.
      </p>
      <p data-testid="restore-explain-funds">
        <strong>It never moves funds.</strong> Your tokens stay in your account, and nothing is sent anywhere.
      </p>
      <p data-testid="restore-explain-check">
        {wallet.Name} will show <strong>Rotate encryption key</strong> and{' '}
        <strong>
          New key <span className="mono">{fp}</span>
        </strong>
        . Approve only if it shows exactly this key. This site never asks you to change your key to any other.
      </p>
      <p className="small muted">Like any approval, it also ends your open offers.</p>
    </Dialog>
  );
}
