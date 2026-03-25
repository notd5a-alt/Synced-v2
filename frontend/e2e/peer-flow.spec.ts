import { test, expect } from '@playwright/test';

test.describe('Peer-to-peer flow', () => {
  test('host creates room, joiner connects, chat exchange, disconnect', async ({ browser }) => {
    // Create two independent browser contexts (simulates two users)
    const hostContext = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const joinerContext = await browser.newContext();

    const hostPage = await hostContext.newPage();
    const joinerPage = await joinerContext.newPage();

    // Host navigates to app and clicks "Host a Session"
    await hostPage.goto('/');
    await expect(hostPage.getByText('Host a Session')).toBeVisible();
    await hostPage.getByText('Host a Session').click();

    // Host should see the lobby with their address
    await expect(hostPage.getByText(/HOSTING SESSION/)).toBeVisible({ timeout: 10000 });

    // Extract the host address from the lobby screen
    const addressEl = hostPage.locator('[data-testid="host-address"]').first();
    // Fallback: look for an element with the address pattern
    let hostAddr: string;
    try {
      hostAddr = await addressEl.textContent({ timeout: 3000 }) ?? '';
    } catch {
      // If no data-testid, find the address by pattern in the page
      const pageText = await hostPage.textContent('body');
      const match = pageText?.match(/(\d+\.\d+\.\d+\.\d+:\d+)/);
      hostAddr = match ? match[1] : '';
    }
    expect(hostAddr).toMatch(/\d+\.\d+\.\d+\.\d+:\d+/);

    // Joiner navigates to app and enters the host address
    await joinerPage.goto('/');
    await joinerPage.getByPlaceholder('Enter host address (ip:port)').fill(hostAddr);
    await joinerPage.getByText('[ JOIN ]').click();

    // Both should reach the session screen (Chat tab visible)
    await expect(hostPage.getByText('[ SEND ]')).toBeVisible({ timeout: 15000 });
    await expect(joinerPage.getByText('[ SEND ]')).toBeVisible({ timeout: 15000 });

    // Host sends a message
    await hostPage.getByPlaceholder('Type a message...').fill('Hello from host!');
    await hostPage.getByText('[ SEND ]').click();

    // Joiner should see the message
    await expect(joinerPage.getByText('Hello from host!')).toBeVisible({ timeout: 5000 });

    // Joiner replies
    await joinerPage.getByPlaceholder('Type a message...').fill('Hi back from joiner!');
    await joinerPage.getByText('[ SEND ]').click();

    // Host should see the reply
    await expect(hostPage.getByText('Hi back from joiner!')).toBeVisible({ timeout: 5000 });

    // Host disconnects
    await hostPage.getByText('[ DISCONNECT ]').click();

    // Host should return to home screen
    await expect(hostPage.getByText('Host a Session')).toBeVisible({ timeout: 5000 });

    // Cleanup
    await hostContext.close();
    await joinerContext.close();
  });
});
