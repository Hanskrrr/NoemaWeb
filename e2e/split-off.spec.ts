import { expect, test } from '@playwright/test';
import { answered, currentThreadId, doubleClickWord } from './helpers.ts';

// "New thread from here": a thread that drifted into a second subject is cut
// at a question; that question and everything after it become a thread of
// their own, and join back undoes it.


test('a new thread from a question: the rest moves with its side question, each links to the other, join back undoes it', async ({
  page,
}) => {
  await page.goto('/#/new');
  await answered(page, 'First subject: TypeScript unions');
  const original = currentThreadId(page);
  await answered(page, 'Second subject: what is a feature store?');
  await answered(page, 'More on feature stores');
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await answered(page, 'A side question about the last answer');
  await page.getByTestId('back').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${original}/from/`));

  const users = page.locator('[data-testid=message][data-role=user]');
  // Not on the first question: that would be the whole thread.
  await users.first().hover();
  await expect(users.first().getByTestId('split-off')).toHaveCount(0);

  await users.nth(1).hover();
  await users.nth(1).getByTestId('split-off').click();
  const confirm = page.getByTestId('split-off-confirm');
  await expect(confirm).toContainText('This question and the 1 after it');
  await expect(confirm).toContainText('its side question');
  await confirm.getByTestId('split-off-confirm-move').click();

  // Now in the new thread: the two questions that moved, the side question with them.
  await expect(page).not.toHaveURL(new RegExp(original));
  const split = currentThreadId(page);
  await expect(users).toHaveCount(2);
  await expect(users.first()).toContainText('Second subject');
  await expect(page.getByTestId('branch-link')).toHaveCount(1);
  await expect(page.getByTestId('continued-from')).toContainText('Split off from');
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${split}"]`)).toBeVisible();

  // The original ends where it was cut, with the way on.
  await page.getByTestId('continued-from').getByRole('button').first().click();
  await expect(page).toHaveURL(new RegExp(`#/t/${original}$`));
  await expect(users).toHaveCount(1);
  await expect(page.getByTestId('branch-link')).toHaveCount(0);
  await page.getByTestId('continued-in').getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${split}$`));

  // Its own map says where it came from.
  await page.getByTestId('open-map').click();
  await expect(page.getByTestId('map-continued-from')).toContainText('Split off from');
  await expect(page.getByTestId('map-exchange')).toHaveCount(3); // its two questions, and the side question's one
  await page.getByTestId('map-back').click();

  // Join back: everything returns, and the first question that moved is shown.
  await page.getByTestId('join-back').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${original}/m/[0-9A-Z]{26}$`));
  await expect(users).toHaveCount(3);
  await expect(page.locator('[data-testid=message].flash')).toContainText('Second subject');
  await expect(page.getByTestId('branch-link')).toHaveCount(1);
  await expect(page.getByTestId('continued-in')).toHaveCount(0);
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${split}"]`)).toHaveCount(0);
});
