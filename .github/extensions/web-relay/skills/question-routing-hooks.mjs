export function createQuestionRoutingHooks({
  api,
  dbg,
  forwardRelayQuestion,
  isAskUserTool,
  normalizeActivityText,
  formatToolActivity,
  extractQuestionChoices,
  maxToolDetailLength = 140,
  getRelayTurnActive,
  getActiveMessage,
  setLastAskUserBridge,
  getLastActivityText,
  setLastActivityText,
  setPendingAskUserRequest,
}) {
  function answerActivityText(answer) {
    const normalized = normalizeActivityText(answer, maxToolDetailLength) || String(answer || "").trim();
    const escaped = normalized.replace(/"/g, "'");
    return {
      normalized,
      text: normalized
        ? `Tool (ask_user): user answered "${escaped}"`
        : "Tool (ask_user): answered via web relay",
    };
  }

  async function onPreToolUse(request) {
    if (!getRelayTurnActive()) {
      return {};
    }

    const activeMsg = getActiveMessage();

    if (isAskUserTool(request) && activeMsg?.id) {
      setLastAskUserBridge(null);
      setPendingAskUserRequest?.(request);
      await api("POST", "/api/activity", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        mode: activeMsg.relayMode || "agent",
        text: "Tool (ask_user): clarification requested in web relay",
      }).catch(() => {});
    }

    const activityText = formatToolActivity(request, maxToolDetailLength);
    if (activityText && activeMsg?.id && activityText !== getLastActivityText()) {
      setLastActivityText(activityText);
      await api("POST", "/api/activity", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        mode: activeMsg.relayMode || "agent",
        text: activityText,
      }).catch(() => {});
    }

    return { permissionDecision: "allow" };
  }

  async function onUserInputRequest(request) {
    const activeMsg = getActiveMessage();
    if (!getRelayTurnActive() || !activeMsg?.id) {
      dbg(
        "ask_user bridge skipped: no active relay turn",
        `relayTurnActive=${String(getRelayTurnActive())}`,
        `hasActiveMessage=${String(!!activeMsg?.id)}`,
      );
      // Throw so the CLI runtime knows input is unavailable.
      // With onUserInputRequest registered at top level (requestUserInput: true), the CLI will not
      // show a terminal prompt for relay turns — this error only fires for non-relay CLI turns.
      throw new Error("ask_user: no active relay turn — user input unavailable outside web relay context.");
    }

    dbg(
      "forwarding user input request for msgId",
      activeMsg.id,
      "mode",
      activeMsg.relayMode || "agent",
      "keys",
      Object.keys(request || {}).join(","),
    );

    await api("POST", "/api/activity", {
      messageId: activeMsg.id,
      conversationId: activeMsg.conversationId,
      mode: activeMsg.relayMode || "agent",
      text: "Tool (ask_user): question posted; waiting for user answer",
    }).catch(() => {});

    setPendingAskUserRequest?.(null); // Normal bridge is handling it — clear so autopilot path is skipped
    const answer = await forwardRelayQuestion(request);
    setLastAskUserBridge({
      source: "onUserInputRequest",
      at: Date.now(),
      messageId: activeMsg.id,
    });
    const activity = answerActivityText(answer);
    await api("POST", "/api/activity", {
      messageId: activeMsg.id,
      conversationId: activeMsg.conversationId,
      mode: activeMsg.relayMode || "agent",
      text: activity.text,
    }).catch(() => {});

    dbg(
      "relay question answered for msgId",
      activeMsg.id,
      "answerLen",
      String(answer.length),
      `answer="${activity.normalized}"`,
    );

    return {
      answer,
      wasFreeform: !extractQuestionChoices(request).length,
    };
  }

  return {
    onPreToolUse,
    onUserInputRequest,
  };
}
