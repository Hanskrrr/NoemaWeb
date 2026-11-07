import { expect, type Page, test } from '@playwright/test';
import { answered, currentThreadId, doubleClickWord, freshThread, showList } from './helpers.ts';

// Notes written by hand get a catalog; text holding several blocks becomes
// several blocks; and threads that came from one another stay together in
// the sidebar.

async function newNote(page: Page) {
  const before = page.url();
  await showList(page, 'notes');
  await page.getByTestId('new-note').click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByTestId('note').getByTestId('block')).toHaveCount(0);
}

async function writeFirst(page: Page, text: string) {
  await page.getByTestId('note').getByTestId('gap-write').click();
  await page.getByTestId('block-textarea').fill(text);
  await page.getByTestId('block-textarea').press('Control+Enter');
}

test('a note written by hand gets a catalog, and one box holding several blocks becomes several blocks', async ({
  page,
}) => {
  await page.goto('/#/new');
  await newNote(page);
  const blocks = page.getByTestId('note').getByTestId('block');
  const outline = page.getByTestId('outline').getByTestId('outline-item');

  // Paragraphs only, no headings: the catalog lists the blocks by their first words.
  await writeFirst(
    page,
    'Read the attention paper first.\n\nThen work out the variance of q·k.\n\nWrite down why we scale by √d.\n\nCheck it against the code.',
  );
  await expect(blocks).toHaveCount(4);
  await expect(outline).toHaveText([
    'Read the attention paper first.',
    'Then work out the variance of q·k.',
    'Write down why we scale by √d.',
    'Check it against the code.',
  ]);

  // A heading and its text in another note: headings make the catalog.
  await newNote(page);
  await writeFirst(page, '# Plan\n\nFirst I read the paper.\n\n## Questions\n\nWhy scale by **root d**?');
  await expect(blocks).toHaveCount(4);
  await expect(outline).toHaveText(['Plan', 'Questions']);

  // Asked for a section, the AI's text is one suggestion; accepted, it is a heading, a paragraph and a list.
  await page.getByTestId('note').getByTestId('gap-end').getByTestId('gap-ask').click();
  await page.getByTestId('ask-input').fill('Type guards [[section]]');
  await page.getByTestId('ask-input').press('Enter');
  const proposal = page.getByTestId('proposal');
  await expect(proposal).toHaveCount(1);
  await expect(proposal).toContainText('A first paragraph about Type guards');
  await proposal.getByTestId('proposal-accept').click();
  await expect(blocks).toHaveCount(7);
  await expect(blocks.nth(4)).toContainText('Type guards');
  await expect(outline).toHaveText(['Plan', 'Questions', 'Type guards']);
});

test('threads that became their own are listed at the top level, right after the thread they came from', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'Machine learning systems: what are they?');
  const main = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await answered(page, 'A side question I make its own thread');
  const own = currentThreadId(page);
  await page.getByTestId('split').click();
  await expect(page.getByTestId('unsplit')).toBeVisible();
  await page.locator(`[data-testid=thread-link][data-thread-id="${main}"]`).click();
  await expect(page.locator('[data-testid=message][data-role=assistant]')).toHaveCount(1);
  await answered(page, 'Now TypeScript: what are union types?');
  const users = page.locator('[data-testid=message][data-role=user]');
  await users.nth(1).hover();
  await users.nth(1).getByTestId('split-off').click();
  await page.getByTestId('split-off-confirm-move').click();
  await expect(page.getByTestId('continued-from')).toBeVisible();
  const continued = currentThreadId(page);

  // Something newer elsewhere does not pull the family apart.
  const rice = await freshThread(request);
  await page.goto(`/#/t/${rice}`);
  await expect(page.locator('[data-testid=message]')).toHaveCount(0);
  await answered(page, 'An unrelated thread about cooking rice');

  // Own threads are their own, at the top level, right after the thread they came from; side questions stay under it.
  const tops = page.locator('.sidebar-list > li');
  const ids = await tops.evaluateAll((lis) =>
    lis.map((li) => li.querySelector(':scope > .thread-row [data-testid=thread-link]')?.getAttribute('data-thread-id')),
  );
  const at = ids.indexOf(main);
  expect(ids.slice(at, at + 3)).toEqual([main, own, continued]);
  await expect(tops.nth(at + 1)).toContainText('↗');
  await expect(tops.nth(at + 2)).toContainText('↪');
  // And asking anywhere in the group brings it all to the top.
  await page.locator(`[data-testid=thread-link][data-thread-id="${own}"]`).click();
  await expect(page.locator('[data-testid=message][data-role=assistant]')).toHaveCount(1);
  await answered(page, 'One more in the side question');
  await expect
    .poll(async () =>
      (
        await tops.evaluateAll((lis) =>
          lis.map((li) =>
            li.querySelector(':scope > .thread-row [data-testid=thread-link]')?.getAttribute('data-thread-id'),
          ),
        )
      ).slice(0, 3),
    )
    .toEqual([main, own, continued]);
});
