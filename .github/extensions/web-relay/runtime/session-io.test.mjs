import test from "node:test";
import assert from "node:assert/strict";
import { createSessionIoHelpers } from "./session-io.mjs";

test("sendWithBestEffortStreaming times out even when the stream never yields", async () => {
  let now = 0;
  let iteratorReturned = false;
  const originalNow = Date.now;
  Date.now = () => now;

  const session = {
    async send() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise(() => {}),
            return: async () => {
              iteratorReturned = true;
              return { done: true };
            },
          };
        },
      };
    },
  };

  const { sendWithBestEffortStreaming } = createSessionIoHelpers({
    getSession: () => session,
    sleep: async (ms) => {
      now += Number(ms) || 0;
    },
    dbg: () => {},
  });

  try {
    await assert.rejects(
      () => sendWithBestEffortStreaming({ prompt: "hello" }, 10, null, { waitPollMs: 5 }),
      (error) => error?.code === "RELAY_STREAM_TIMEOUT",
    );
    assert.equal(iteratorReturned, true);
  } finally {
    Date.now = originalNow;
  }
});

test("sendWithBestEffortStreaming runs onWaiting while the stream is idle", async () => {
  let now = 0;
  let waitingCalls = 0;
  const originalNow = Date.now;
  Date.now = () => now;

  const session = {
    async send() {
      return {
        [Symbol.asyncIterator]() {
          let delivered = false;
          return {
            next: async () => {
              if (delivered) return { done: true };
              delivered = true;
              now += 5;
              return { done: false, value: { data: { text: "done" } } };
            },
            return: async () => ({ done: true }),
          };
        },
      };
    },
  };

  const { sendWithBestEffortStreaming } = createSessionIoHelpers({
    getSession: () => session,
    sleep: async (ms) => {
      waitingCalls += 1;
      now += Number(ms) || 0;
    },
    dbg: () => {},
  });

  try {
    const result = await sendWithBestEffortStreaming(
      { prompt: "hello" },
      30,
      null,
      {
        waitPollMs: 5,
        onWaiting: async () => {},
      },
    );
    assert.deepEqual(result, { data: { text: "done" } });
    assert.equal(waitingCalls > 0, true);
  } finally {
    Date.now = originalNow;
  }
});
