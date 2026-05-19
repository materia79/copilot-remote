'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_FEATURES = Object.freeze({
  sdkSessionSourceOfTruth: false,
  sdkSessionReadPath: false,
  sdkDeleteLifecycle: false,
  askUserSessionScoped: false,
});

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
      Object.keys(DEFAULT_FEATURES).map((key) => [key, Boolean(configured[key])]),
    );
  } catch {
    return {};
  }
}

export const FEATURES = Object.freeze({
  ...DEFAULT_FEATURES,
  ...readFeaturesFromConfig(),
});
