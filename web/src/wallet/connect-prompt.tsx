// "Connect Phantom" from anywhere on the page (AA 00047 P8.1): the header owns the wallet menu, and
// a page's call to action asks it to connect: straight to the one wallet this browser has, or by
// opening the header's menu to choose.

import { createContext, useContext } from 'react';

import { useWallet } from './WalletContext.js';

export const ConnectPromptContext = createContext<(() => void) | null>(null);

/** Start connecting (a page's call to action); null while connecting is not possible here. */
export function useConnectPrompt(): (() => void) | null {
  const open = useContext(ConnectPromptContext);
  const w = useWallet();
  if (!open || !w.supported || w.status !== 'disconnected') return null;
  return () => {
    const only = w.options.length === 1 ? w.options[0] : undefined;
    if (only) void w.connect(only);
    else open();
  };
}
