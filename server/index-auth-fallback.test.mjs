import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('./public/index.html', import.meta.url));
const source = fs.readFileSync(indexPath, 'utf8');

test('index auth gate uses resilient connect handler', () => {
  assert.match(source, /window\.__copilotAuthConnect = async \(event\) => \{/);
  assert.match(source, /if \(typeof window\.doAuth === 'function'\) \{/);
  assert.match(source, /fetch\(`\$\{__APP_BASE\}\/api\/status`, \{/);
  assert.match(source, /window\.location\.reload\(\);/);
  assert.match(source, /onclick="window\.__copilotAuthConnect\(event\)"/);
  assert.match(source, /onkeydown="if\(event\.key==='Enter'\)window\.__copilotAuthConnect\(event\)"/);
});
