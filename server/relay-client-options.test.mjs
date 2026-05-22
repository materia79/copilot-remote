import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCopilotClientOptions } from './relay.mjs';

test('foreground tcp client options omit useLoggedInUser', () => {
  const options = buildCopilotClientOptions({
    foreground: true,
    tcpInfo: { port: 4445, tcpConnectionToken: 'abc123' },
    cliPath: 'C:\\dummy\\cli.js',
    launchRoot: 'R:\\',
  });

  assert.deepEqual(options, {
    cliUrl: 'localhost:4445',
    tcpConnectionToken: 'abc123',
  });
});

test('hidden client options keep useLoggedInUser', () => {
  const options = buildCopilotClientOptions({
    foreground: false,
    cliPath: 'C:\\dummy\\cli.js',
    launchRoot: 'R:\\',
  });

  assert.equal(options.cliPath, 'C:\\dummy\\cli.js');
  assert.equal(options.useLoggedInUser, true);
  assert.equal(options.logLevel, 'debug');
  assert.equal(options.cwd, 'R:\\');
});
