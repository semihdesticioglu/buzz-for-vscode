import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasAllTranslations, lang, resolveLang, setLang, t, webviewStrings } from '../i18n';

test('every English string has a Turkish translation', () => {
  assert.ok(hasAllTranslations());
});

test('language setting: explicit choice wins, "auto" follows VS Code', () => {
  assert.equal(resolveLang('tr', 'en'), 'tr');
  assert.equal(resolveLang('en', 'tr'), 'en');
  assert.equal(resolveLang('auto', 'tr'), 'tr');
  assert.equal(resolveLang('auto', 'en-us'), 'en');
  assert.equal(resolveLang(undefined, 'de'), 'en');
});

test('placeholders are filled and the language can be switched', () => {
  setLang('en');
  assert.equal(t('ui.replies', 3), '💬 3 replies');
  setLang('tr');
  try {
    assert.equal(lang(), 'tr');
    assert.equal(t('ui.replies', 3), '💬 3 yanıt');
    assert.equal(webviewStrings().apply, 'Uygula');
  } finally {
    setLang('en');
  }
  assert.equal(webviewStrings().apply, 'Apply');
});

test('every T() key used by the webview exists', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat.js'), 'utf8');
  const keys = new Set([...js.matchAll(/\bT\('([A-Za-z]+)'/g)].map((m) => m[1]));
  const html = fs.readFileSync(path.join(__dirname, '..', 'chatHtml.js'), 'utf8');
  for (const m of html.matchAll(/\b(?:tx|ti)\('([A-Za-z]+)'\)/g)) keys.add(m[1]);
  const have = webviewStrings();
  const missing = [...keys].filter((k) => !(k in have));
  assert.deepEqual(missing, []);
  assert.ok(keys.size > 40);
});

test('package.nls files have the same keys', () => {
  const root = path.join(__dirname, '..', '..');
  const en = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8')));
  const tr = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.nls.tr.json'), 'utf8')));
  assert.deepEqual(tr, en);
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const used = [...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
  assert.deepEqual(
    used.filter((k) => !en.includes(k)),
    [],
  );
});
