const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDirectory = path.join(__dirname, '..', 'public');

test('every dialog close control is a non-submit button handled by the delegated close action', () => {
  const html = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(publicDirectory, 'app.js'), 'utf8');
  const dialogCount = (html.match(/<dialog\b/g) || []).length;
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map((match) => ({ attributes: match[1], text: match[2].replace(/<[^>]+>/g, '').trim() }));
  const closeControls = buttons.filter((button) => /\bdata-dialog-close\b/.test(button.attributes));

  assert.equal(closeControls.length, dialogCount * 2, 'each dialog should have a header and footer close control');
  for (const button of closeControls) {
    assert.match(button.attributes, /\btype="button"/, `${button.text || 'icon close'} must not submit its form`);
  }
  assert.equal(html.includes('value="cancel"'), false);
  assert.match(app, /event\.target\.closest\('\[data-dialog-close\]'\)/);
  assert.match(app, /closeControl\.closest\('dialog'\)\?\.close\('cancel'\)/);
});
