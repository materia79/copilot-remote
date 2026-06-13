/**
 * tmux-input-bridge.mjs
 * 
 * Bridges web relay answers to tmux terminal prompts.
 * When the CLI shows its native ask_user prompt (because onUserInputRequest isn't working),
 * this utility sends keystrokes via tmux to select or type the user's answer.
 */

import { spawn } from "child_process";

/**
 * Send keys to a tmux session.
 * @param {string} sessionName - tmux session name (usually the Copilot session ID)
 * @param {string[]} keys - Array of key names to send (e.g., ["Down", "Down", "Enter"])
 * @returns {Promise<void>}
 */
export function sendTmuxKeys(sessionName, keys) {
  return new Promise((resolve, reject) => {
    if (!sessionName || !keys?.length) {
      resolve();
      return;
    }

    const args = ["send-keys", "-t", sessionName, ...keys];
    const proc = spawn("tmux", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tmux send-keys failed (code ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Type text into a tmux session (for freeform input).
 * @param {string} sessionName - tmux session name
 * @param {string} text - Text to type
 * @returns {Promise<void>}
 */
export function typeTmuxText(sessionName, text) {
  return new Promise((resolve, reject) => {
    if (!sessionName || !text) {
      resolve();
      return;
    }

    // Strip control characters (< 0x20, except tab) to prevent injection into the pty
    const safeText = text.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "");

    // send-keys with -l flag sends literal text
    const args = ["send-keys", "-t", sessionName, "-l", safeText];
    const proc = spawn("tmux", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tmux send-keys (text) failed (code ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Answer a CLI ask_user prompt by sending keys to tmux.
 * 
 * @param {object} options
 * @param {string} options.sessionName - tmux session name
 * @param {string} options.answer - The user's answer text
 * @param {string[]} options.choices - Available choices from the ask_user request
 * @param {boolean} options.wasFreeform - Whether the answer was freeform text
 * @param {Function} options.dbg - Debug logger
 * @returns {Promise<boolean>} - true if successfully sent, false otherwise
 */
export async function answerCliPromptViaTmux({
  sessionName,
  answer,
  choices = [],
  wasFreeform = false,
  dbg = () => {},
}) {
  if (!sessionName) {
    dbg("tmux bridge: no session name provided");
    return false;
  }

  try {
    const normalizedAnswer = String(answer || "").trim();
    
    if (!wasFreeform && choices.length > 0) {
      // Find the index of the selected choice
      const choiceIndex = choices.findIndex(
        (c) => String(c || "").trim().toLowerCase() === normalizedAnswer.toLowerCase()
      );

      if (choiceIndex >= 0) {
        // Navigate to the choice with Down keys, then press Enter
        const keys = [];
        for (let i = 0; i < choiceIndex; i++) {
          keys.push("Down");
        }
        keys.push("Enter");
        
        dbg(`tmux bridge: selecting choice ${choiceIndex} with keys:`, keys.join(", "));
        await sendTmuxKeys(sessionName, keys);
        return true;
      }
    }

    // Freeform answer: navigate to "Other" (last option), select it, type, then Enter
    if (choices.length > 0) {
      // Navigate to the last item (usually "Other")
      const keys = [];
      for (let i = 0; i < choices.length; i++) {
        keys.push("Down");
      }
      keys.push("Enter"); // Select "Other"
      
      dbg(`tmux bridge: navigating to Other with ${keys.length - 1} Downs`);
      await sendTmuxKeys(sessionName, keys);
      
      // Small delay to let the UI update
      await new Promise((r) => setTimeout(r, 100));
    }

    // Type the freeform answer
    dbg(`tmux bridge: typing freeform answer (${normalizedAnswer.length} chars)`);
    await typeTmuxText(sessionName, normalizedAnswer);
    
    // Press Enter to submit
    await sendTmuxKeys(sessionName, ["Enter"]);
    
    return true;
  } catch (err) {
    dbg("tmux bridge error:", err?.message || String(err));
    return false;
  }
}

/**
 * Decline a CLI ask_user prompt by sending Ctrl+D to tmux.
 * @param {string} sessionName - tmux session name
 * @param {Function} dbg - Debug logger
 * @returns {Promise<boolean>}
 */
export async function declineCliPromptViaTmux(sessionName, dbg = () => {}) {
  if (!sessionName) {
    dbg("tmux bridge decline: no session name provided");
    return false;
  }

  try {
    // Ctrl+D is represented as C-d in tmux
    dbg("tmux bridge: sending Ctrl+D to decline prompt");
    await sendTmuxKeys(sessionName, ["C-d"]);
    return true;
  } catch (err) {
    dbg("tmux bridge decline error:", err?.message || String(err));
    return false;
  }
}

/**
 * Check if tmux is available on this system.
 * @returns {Promise<boolean>}
 */
export function isTmuxAvailable() {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["-V"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
