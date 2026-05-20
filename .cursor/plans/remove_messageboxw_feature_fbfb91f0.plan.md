---
name: Remove MessageBoxW Feature
overview: Fully remove MessageBoxW feature artifacts from the current repository state (no history rewrite), verify no residual references, and preserve relay behavior.
todos:
  - id: baseline-scan
    content: Capture a baseline inventory of MessageBoxW-related symbols and file paths
    status: cancelled
  - id: remove-feature-artifacts
    content: Remove MessageBoxW extension implementation and any now-empty MessageBoxW folder artifacts
    status: cancelled
  - id: clean-doc-config-stragglers
    content: Remove any discovered MessageBoxW mentions from docs/config/tests if present
    status: cancelled
  - id: repo-wide-verification
    content: Re-run repository-wide searches to ensure zero remaining MessageBoxW references
    status: cancelled
  - id: safety-verification
    content: Verify unrelated web-relay behavior and ensure git diff only includes intended cleanup
    status: cancelled
isProject: false
---

# Remove MessageBoxW Feature Plan

## Goal

Remove all MessageBoxW-related feature artifacts from the current branch/worktree so the tool is no longer shipped, documented, or referenced anywhere in active source, while keeping the rest of the extension and relay system unchanged.

## Scope Decisions

- **Cleanup scope:** Full cleanup in tracked files (implementation + any docs/config/tests references if present).
- **History policy:** No git history rewrite; removal is done as normal forward changes in this branch.
- **Out of scope:** Purging past commits, force-push workflows, or unrelated relay refactors.

## Current Findings (from pre-plan scan)

- Primary implementation is currently isolated to [.github/extensions/messageboxw-tool/extension.mjs](c:/git/copilot-remote/.github/extensions/messageboxw-tool/extension.mjs).
- Known identifiers to eliminate:
  - `open_message_box_w_bg`
  - `MessageBoxW`
  - `messageboxw-tool`
- No direct references were found in checked README/server/relay code paths during initial scan, but full cleanup still includes a final sweep to catch any stragglers.

## Comprehensive Execution Planw

1. **Baseline inventory**
  - Run a fresh repo-wide symbol/path search for `MessageBoxW`, `open_message_box_w_bg`, and `messageboxw-tool`.
  - Record exact files hit so post-cleanup verification can be compared directly.
2. **Remove implementation artifacts**
  - Delete [.github/extensions/messageboxw-tool/extension.mjs](c:/git/copilot-remote/.github/extensions/messageboxw-tool/extension.mjs).
  - Remove `.github/extensions/messageboxw-tool/` directory if it becomes empty after deletion.
3. **Clean secondary references (if discovered)**
  - Inspect and remove any MessageBoxW mentions from:
    - docs (`README` files, contributor notes)
    - config/instructions (`.github` guidance files)
    - tests/fixtures/scripts referencing the tool name
  - Keep edits narrowly scoped to MessageBoxW-related lines only.
4. **Verify no residual references**
  - Re-run repo-wide searches for all known identifiers.
  - Confirm zero remaining hits in tracked source/docs/config/tests.
5. **Safety checks**
  - Confirm no changes are introduced in unrelated areas unless they directly remove MessageBoxW references.
  - Validate cleanup does not alter expected web-relay extension behavior (no touch to [.github/extensions/web-relay/extension.mjs](c:/git/copilot-remote/.github/extensions/web-relay/extension.mjs) logic unless a direct dependency is discovered).
  - Review `git diff`/status to ensure final change set is intentional and minimal.

## Acceptance Criteria

- `.github/extensions/messageboxw-tool/` contains no active implementation artifacts.
- No occurrences remain for `MessageBoxW`, `open_message_box_w_bg`, or `messageboxw-tool` in tracked repository files.
- No unexpected edits appear outside the targeted cleanup scope.
- Repository is ready for a single cleanup commit without history rewrite.

## Risks and Mitigations

- **Risk:** A hidden or indirect mention is missed.
  - **Mitigation:** Use identifier-based global search both before and after removal.
- **Risk:** Cleanup accidentally includes unrelated dirty-tree changes.
  - **Mitigation:** Explicitly review diff scope and keep only MessageBoxW-targeted edits in the plan execution.

## Optional Future Hardening

- Add a lightweight contributor note discouraging one-off OS popup/debug extensions from being committed unless they are part of a supported product flow.

