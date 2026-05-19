'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_FEATURES = Object.freeze({});

function readFeaturesFromConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const configured = parsed && typeof parsed === 'object' ? parsed.features : null;
    if (!configured || typeof configured !== 'object') {
      return {};
    }

    return Object.fromEntries(
      Object.entries(configured).map(([key, value]) => [String(key), Boolean(value)]),
    );
  } catch {
    return {};
  }
}

export const FEATURES = Object.freeze({
  ...DEFAULT_FEATURES,
  ...readFeaturesFromConfig(),
});
