'use strict';

import { createHash } from 'crypto';
import path from 'path';

function normalizeWorkspaceRoot(workspaceRoot) {
  return path.resolve(String(workspaceRoot || '').trim() || process.cwd());
}

export function buildWindowsTerminalWindowName(workspaceRoot, prefix = 'copilot-relay') {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot).replace(/[\\/]+/g, '/').toLowerCase();
  const fingerprint = createHash('sha256').update(normalizedRoot).digest('hex').slice(0, 12);
  return `${prefix}-${fingerprint}`;
}

export function buildWindowsTerminalForegroundArgs({
  workspaceRoot,
  windowName,
  title = 'Copilot Relay',
  commandPath,
  commandArgs = [],
}) {
  const args = ['-w', String(windowName || '').trim()];
  args.push('new-tab');
  args.push('--startingDirectory', normalizeWorkspaceRoot(workspaceRoot));
  args.push('--title', String(title || '').trim() || 'Copilot Relay');
  args.push(commandPath, ...commandArgs);
  return args;
}
