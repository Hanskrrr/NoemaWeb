import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { freshThread } from './helpers.ts';

// Folders on this computer (ADR 0025): linked in Files, in the sidebar; a
// file opens as a source, read again when it changed on disk; a text file is
// edited in place; a note is saved into the folder, a file becomes a note;
// the Assistant's changes to files wait for Do it and can be undone.
// Every folder here is made by the test, with made-up files.

const H = { 'x-noema-client': 'web' };

function makeFolder(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'noema-e2e-')), 'Course');
  mkdirSync(join(root, 'week4'), { recursive: true });
  writeFileSync(join(root, 'week4', 'notes.md'), '# Week 4\n\nData parallel: every worker holds a copy of the model.\n');
  writeFileSync(join(root, 'train.py'), 'def step(batch):\n    return mean(grads)\n');
  writeFileSync(join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  return root;
}

async function linkInFiles(page: Page, path: string): Promise<void> {
  await page.getByTestId('rail-files').click();
  await page.getByTestId('link-folder').click();
  await page.getByTestId('link-folder-path').fill(path);
  await page.getByTestId('link-folder-submit').click();
  await expect(page.getByTestId('file-folder').filter({ hasText: 'Course' }).last()).toBeVisible();
}

const folderRow = (page: Page) => page.getByTestId('file-folder').last();

test.afterEach(async ({ request }) => {
  // Unlinked, so other tests see no folders.
  const nb = await (await request.get('/api/notebooks')).json();
  const { folders } = await (await request.get(`/api/notebooks/${nb.notebooks[0].id}/folders`)).json();
  for (const f of folders) await request.delete(`/api/folders/${f.id}`, { headers: H });
});

test('a folder is linked in Files; a file opens as a source, is read again when it changes, and is edited in place', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const root = makeFolder();
  await page.goto('/');
  await linkInFiles(page, root);

  // Folders first; a picture cannot be opened.
  const rows = folderRow(page).locator('[data-testid=file-dir], [data-testid=file-link]').locator('.file-name');
  await expect(rows).toHaveText(['week4', 'photo.png', 'train.py']);
  await expect(folderRow(page).locator('[data-testid=file-link][data-path="photo.png"]')).toBeDisabled();

  // A code file: a source, shown as code, marked in the list.
  await folderRow(page).locator('[data-testid=file-link][data-path="train.py"]').click();
  await expect(page.getByTestId('source-file-path')).toHaveText(/Course\/train\.py/);
  await expect(page.getByTestId('source-text').locator('pre code')).toContainText('return mean(grads)');
  await expect(folderRow(page).locator('[data-testid=file-link][data-path="train.py"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('sidebar-panel')).toHaveAttribute('aria-label', 'Files');

  // Changed on disk: read again when opened again, a new version.
  writeFileSync(join(root, 'train.py'), 'def step(batch):\n    return all_reduce(grads)\n');
  await folderRow(page).locator('[data-testid=file-link][data-path="train.py"]').click();
  await expect(page.getByTestId('source-notice')).toContainText('The file changed on disk: this is version 2');
  await expect(page.getByTestId('source-text')).toContainText('return all_reduce(grads)');

  // Edited here: saved into the folder, a new version again.
  await page.getByTestId('source-edit-file').click();
  const editor = page.getByTestId('file-editor-text');
  await expect(editor).toHaveValue('def step(batch):\n    return all_reduce(grads)\n');
  await editor.fill('def step(batch):\n    return all_reduce(grads) / n\n');
  await editor.press('ControlOrMeta+s');
  await expect(page.getByTestId('file-editor')).toHaveCount(0);
  await expect(page.getByTestId('source-notice')).toContainText('Saved into the folder: this is version 3');
  expect(readFileSync(join(root, 'train.py'), 'utf8')).toBe('def step(batch):\n    return all_reduce(grads) / n\n');

  // Changed on disk while editing: refused, and the text typed is kept.
  await page.getByTestId('source-edit-file').click();
  await expect(editor).toHaveValue(/\/ n/);
  writeFileSync(join(root, 'train.py'), 'changed elsewhere\n');
  await editor.fill('mine\n');
  await page.getByTestId('file-editor-save').click();
  await expect(page.getByTestId('file-editor-error')).toContainText('The file changed on disk since it was read');
  await expect(editor).toHaveValue('mine\n');
  expect(readFileSync(join(root, 'train.py'), 'utf8')).toBe('changed elsewhere\n');
  await page.getByTestId('file-editor-cancel').click();
});

test('a file becomes a note; a note is saved into the folder, replacing a file only when asked', async ({ page, request }) => {
  await freshThread(request);
  const root = makeFolder();
  await page.goto('/');
  await linkInFiles(page, root);
  await folderRow(page).locator('[data-testid=file-dir][data-path="week4"]').click();
  await folderRow(page).locator('[data-testid=file-link][data-path="week4/notes.md"]').click();
  await expect(page.getByTestId('source-text')).toContainText('every worker holds a copy');

  await page.getByTestId('source-note-from-file').click();
  await expect(page.getByTestId('note')).toBeVisible();
  await expect(page.getByTestId('note-rename')).toContainText('Week 4');
  await expect(page.getByTestId('note')).toContainText('every worker holds a copy of the model');

  await page.getByTestId('note-save-to-folder').click();
  await expect(page.getByTestId('save-to-folder-path')).toHaveValue('Week 4.md');
  await page.getByTestId('save-to-folder-path').fill('week4/notes.md');
  await page.getByTestId('save-to-folder-save').click();
  await expect(page.getByTestId('save-to-folder-error')).toContainText('There is already a file “week4/notes.md”');
  await page.getByTestId('save-to-folder-path').fill('summary.md');
  await page.getByTestId('save-to-folder-save').click();
  await expect(page.getByTestId('save-to-folder-done')).toContainText('Course/summary.md');
  expect(readFileSync(join(root, 'summary.md'), 'utf8')).toMatch(/^# Week 4\n\nData parallel/);

  await page.getByTestId('save-to-folder-open').click();
  await expect(page.getByTestId('source-file-path')).toHaveText(/Course\/summary\.md/);
});

test('the Assistant proposes a change to a file, shows it, does it on Do it, and undoes it', async ({ page, request }) => {
  await freshThread(request);
  const root = makeFolder();
  await page.goto('/');
  await linkInFiles(page, root);
  await page.getByTestId('assistant-open').click();
  const dock = page.getByTestId('assistant-dock');
  const call = JSON.stringify({ path: 'Course/train.py', old: 'mean(grads)', new: 'all_reduce(grads)' });
  await dock.getByTestId('composer').fill(`Fix the step [[call:edit_file:${call}]]`);
  await dock.getByTestId('composer').press('Enter');
  const card = dock.getByTestId('action-card').last();
  await expect(card).toHaveAttribute('data-kind', 'edit_file');
  await expect(card).toContainText('Edit “Course/train.py”');
  await expect(card.getByTestId('action-detail').locator('.del')).toHaveText('- mean(grads)');
  await expect(card.getByTestId('action-detail').locator('.ins')).toHaveText('+ all_reduce(grads)');
  expect(readFileSync(join(root, 'train.py'), 'utf8')).toContain('mean(grads)');

  await card.getByTestId('action-run').click();
  await expect(card).toHaveAttribute('data-status', 'done');
  expect(readFileSync(join(root, 'train.py'), 'utf8')).toBe('def step(batch):\n    return all_reduce(grads)\n');
  await card.getByTestId('action-undo').click();
  await expect(card).toHaveAttribute('data-status', 'undone');
  expect(readFileSync(join(root, 'train.py'), 'utf8')).toBe('def step(batch):\n    return mean(grads)\n');
});
