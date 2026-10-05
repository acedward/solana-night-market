// AA 00060 P12.1c (spec FR-023): the Portfolio shows the holdings and a list of actions; each flow (Send,
// Bridge in, Bridge out, Mint Midnight tokens, Mint Solana tokens) opens as its own sub-page
// (`#account?action=<id>`). The tests open a flow the way a customer does: from the list.

import { expect, type Page } from '@playwright/test';

export type PortfolioAction = 'send' | 'bridge-in' | 'bridge-out' | 'mint-midnight' | 'mint-solana';

/** The action's entry in the Portfolio's list. */
export const actionItem = (page: Page, id: PortfolioAction) =>
  page.locator(`[data-testid=portfolio-action][data-action="${id}"]`);

/** Open an action's flow from the Portfolio's list (going back to the list first when a flow is open). */
export async function openAction(page: Page, id: PortfolioAction): Promise<void> {
  const back = page.getByTestId('portfolio-back');
  if (await back.isVisible()) await back.click();
  await actionItem(page, id).click();
  await expect(page.getByTestId('portfolio-flow')).toHaveAttribute('data-action', id);
}
