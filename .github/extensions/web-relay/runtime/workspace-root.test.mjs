import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspaceRootPath } from "./workspace-root.mjs";

test("resolveWorkspaceRootPath prefers explicit workspace env over cwd", () => {
  const root = resolveWorkspaceRootPath({
    env: {
      COPILOT_WORKSPACE_ROOT: "I:\\rabi-ribi",
      INIT_CWD: "C:\\fallback",
    },
    cwd: "C:\\git\\copilot-remote",
  });
  assert.equal(root, "I:\\rabi-ribi");
});

test("resolveWorkspaceRootPath uses session metadata before generic cwd", () => {
  const root = resolveWorkspaceRootPath({
    session: {
      context: {
        currentWorkingDirectory: "D:\\project",
      },
    },
    env: {},
    cwd: "C:\\git\\copilot-remote",
  });
  assert.equal(root, "D:\\project");
});

test("resolveWorkspaceRootPath falls back to INIT_CWD when launcher env is unavailable", () => {
  const root = resolveWorkspaceRootPath({
    env: {
      INIT_CWD: "E:\\workspace",
    },
    cwd: "C:\\git\\copilot-remote",
  });
  assert.equal(root, "E:\\workspace");
});

test("resolveWorkspaceRootPath ultimately falls back to process cwd", () => {
  const root = resolveWorkspaceRootPath({
    env: {},
    cwd: "C:\\git\\copilot-remote",
  });
  assert.equal(root, "C:\\git\\copilot-remote");
});

test("resolveWorkspaceRootPath can skip process cwd fallback for startup learning", () => {
  const root = resolveWorkspaceRootPath({
    env: {},
    cwd: "C:\\git\\copilot-remote",
    includeProcessCwd: false,
  });
  assert.equal(root, null);
});
