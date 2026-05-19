'use strict';
import express from 'express';
import fs from 'fs';
import path from 'path';

export function registerMessagesRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    config,
    uuidv4,
    ts,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_ATTACHMENTS,
    MAX_IMAGE_DATA_URL_LENGTH,
    MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES,
    remotePath,
    parseBooleanQueryFlag,
    buildRepositoryTreeSnapshot,
    fetchBrowsableDrives,
    fetchDriveDirectoryEntries,
    mapDriveDirectoryEntry,
    driveDisplayName,
    normalizeDriveAbsolutePath,
    driveRootFromAbsolutePath,
    toDriveWebPath,
    readWorkspaceFileMeta,
    resolveWorkspaceFilePath,
    previewLanguageForWorkspaceFile,
    readWorkspaceFilePreviewBuffer,
    isLikelyBinaryPreviewBuffer,
    isLikelyTextContentType,
    workspacePreviewKindForMeta,
    workspaceContentType,
    persistUploadBuffer,
    isSha256,
    uploadPathForSha,
    uploadContentUrlForSha,
    maybeApplyWorkspaceRootFromMessage,
    getOrCreateConversation,
    ensureRuntimeSessionBinding,
    linkUploadReferences,
    normalizeAttachments,
    collectReferenceAttachmentsFromText,
    mergeMessageAttachments,
    attachmentSummary,
    createCompactedConversation,
    workspaceRootPayload,
    queueCounts,
    getModelCatalogState,
    buildRelayReadyBannerData,
    ensureSessionId,
    touchCli,
    recoverProcessingOlderThan,
    addMsIso,
    computeRetryDelayMs,
    normalizeRelayMode,
    DEFAULT_RELAY_MODE,
    DEFAULT_MODEL,
    configuredConversationSessionMode,
    parseAttachments,
    hydrateAttachment,
    relayActivityForResponse,
    relayActivityForQueueMessage,
    sanitizeActivityText,
    inFlightStateForConversation,
    emitToClientsExceptSessionId,
  } = deps;

  app.post('/api/upload', auth, express.raw({ type: () => true, limit: `${MAX_UPLOAD_BYTES}b` }), (req, res) => {
    const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!payload.length) return res.status(400).json({ error: 'Empty upload payload' });
    if (payload.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'Uploaded file too large' });

    const rawNameHeader = String(req.headers['x-file-name'] || req.query.name || '').trim();
    let decodedName = '';
    try { decodedName = decodeURIComponent(rawNameHeader); } catch { decodedName = rawNameHeader; }
    const fileName = decodedName || `upload-${Date.now()}`;
    const fileType = String(req.headers['x-file-type'] || req.headers['content-type'] || req.query.type || 'application/octet-stream').trim().toLowerCase();

    try {
      const attachment = persistUploadBuffer(payload, { name: fileName, type: fileType });
      if (!attachment) return res.status(500).json({ error: 'Upload persistence failed' });
      res.json({ ok: true, attachment });
    } catch (e) {
      res.status(400).json({ error: e?.message || 'Upload failed' });
    }
  });

  app.get('/api/upload/:sha256/content', auth, (req, res) => {
    const sha256 = String(req.params.sha256 || '').trim().toLowerCase();
    if (!isSha256(sha256)) return res.status(400).json({ error: 'Invalid file id' });
    const file = stmts.getUploadFile.get(sha256);
    if (!file) return res.status(404).json({ error: 'Not found' });
    const filePath = uploadPathForSha(sha256);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Missing file on disk' });
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(filePath).pipe(res);
  });

  app.get('/api/files/*', auth, (req, res) => {
    const requestedPath = String(req.params?.[0] || '').trim();
    const filePath = resolveWorkspaceFilePath(requestedPath);
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    const safeName = path.basename(filePath).replace(/"/g, '');
    res.setHeader('Content-Type', meta.contentType);
    res.setHeader('Content-Length', String(meta.size));
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      workspaceFileMetaCache.delete(filePath);
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to read file' });
    });
    stream.pipe(res);
  });

  app.get('/api/files-preview/*', auth, (req, res) => {
    const requestedPath = String(req.params?.[0] || '').trim();
    const normalizedPath = normalizeWorkspaceRelativePath(requestedPath);
    const filePath = resolveWorkspaceFilePath(requestedPath);
    if (!filePath || !normalizedPath) return res.status(400).json({ error: 'Invalid file path' });

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    const ext = path.extname(filePath).toLowerCase();
    const size = Number(meta.size || 0);
    const contentType = meta.contentType || workspaceContentType(filePath);
    const language = previewLanguageForWorkspaceFile(filePath);

    let previewBuffer = Buffer.alloc(0);
    try {
      previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
    } catch (error) {
      workspaceFileMetaCache.delete(filePath);
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.status(500).json({ error: 'Failed to read file' });
    }

    const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
    const contentBuffer = truncated
      ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
      : previewBuffer;

    const likelyBinaryType = contentType === 'application/pdf'
      || contentType === 'application/octet-stream';
    const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
    const likelyTextType = isLikelyTextContentType(contentType);

    let kind = workspacePreviewKindForMeta(ext, contentType);
    if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
      kind = 'binary';
    } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
      kind = 'binary';
    }

    const normalizedWebPath = normalizedPath.replace(/\\/g, '/');
    const payload = {
      ok: true,
      path: normalizedWebPath,
      name: path.basename(filePath),
      kind,
      language,
      contentType,
      size,
      truncated,
      previewBytes: contentBuffer.length,
      rawUrl: `${remotePath}/api/files/${normalizedWebPath.split('/').map((part) => encodeURIComponent(part)).join('/')}`,
    };

    if (kind !== 'binary' && kind !== 'image') {
      payload.content = contentBuffer.toString('utf8');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  app.get('/api/repo/tree', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const includeHeavy = parseBooleanQueryFlag(req.query.includeHeavy, false);
    const snapshot = buildRepositoryTreeSnapshot({ includeHidden, includeHeavy, maxNodes: MAX_REPO_TREE_NODES });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      ...snapshot,
    });
  });

  app.get('/api/drives/roots', auth, (req, res) => {
    fetchBrowsableDrives((err, drives) => {
      if (err) return res.status(500).json({ error: err.message || 'Failed to enumerate drives' });
      const root = {
        path: '',
        name: 'Drives',
        type: 'dir',
        children: drives.map((drive) => ({
          path: drive.webPath,
          name: driveDisplayName(drive),
          type: 'dir',
          driveType: drive.driveType,
          label: drive.label || '',
          sizeBytes: drive.sizeBytes,
          freeBytes: drive.freeBytes,
          children: [],
          lazy: true,
          childrenLoaded: false,
        })),
        childrenLoaded: true,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        root,
        nodeCount: root.children.length + 1,
        truncated: false,
        maxNodes: root.children.length + 1,
        includeHidden: false,
        includeHeavy: false,
        rootName: 'Drives',
        driveTypes: ['fixed', 'removable'],
      });
    });
  });

  app.get('/api/drives/list', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const requestedPath = String(req.query.path || '').trim();

    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const absolutePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
      if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive path' });
      }

      let stat = null;
      try {
        stat = fs.statSync(absolutePath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return res.status(404).json({ error: 'Path not found' });
        return res.status(500).json({ error: error?.message || 'Failed to read path metadata' });
      }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must reference a directory' });

      fetchDriveDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list directory' });
        const children = entries
          .map(mapDriveDirectoryEntry)
          .filter((entry) => {
            if (!entry?.path) return false;
            const entryRoot = driveRootFromAbsolutePath(entry.path).toUpperCase();
            return allowedRoots.has(entryRoot);
          });
        const driveMeta = drives.find((drive) => drive.rootAbsolute.toUpperCase() === rootAbsolute);
        const nodePath = toDriveWebPath(absolutePath);
        const node = {
          path: nodePath,
          name: absolutePath.length <= 3 ? driveDisplayName(driveMeta) : (path.win32.basename(absolutePath) || nodePath),
          type: 'dir',
          driveType: driveMeta?.driveType || null,
          label: driveMeta?.label || '',
          children,
          childrenLoaded: true,
        };
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          node,
          includeHidden,
        });
      });
    });
  });

  app.get('/api/drives/file', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();
    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const filePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
      if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive file path' });
      }

      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      const safeName = path.win32.basename(filePath).replace(/"/g, '');
      res.setHeader('Content-Type', meta.contentType);
      res.setHeader('Content-Length', String(meta.size));
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const stream = fs.createReadStream(filePath);
      stream.on('error', (error) => {
        workspaceFileMetaCache.delete(filePath);
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          res.status(404).json({ error: 'File not found' });
          return;
        }
        res.status(500).json({ error: 'Failed to read file' });
      });
      stream.pipe(res);
    });
  });

  app.get('/api/drives/files-preview', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();
    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const filePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
      if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive file path' });
      }

      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      const ext = path.extname(filePath).toLowerCase();
      const size = Number(meta.size || 0);
      const contentType = meta.contentType || workspaceContentType(filePath);
      const language = previewLanguageForWorkspaceFile(filePath);

      let previewBuffer = Buffer.alloc(0);
      try {
        previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
      } catch (error) {
        workspaceFileMetaCache.delete(filePath);
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return res.status(404).json({ error: 'File not found' });
        }
        return res.status(500).json({ error: 'Failed to read file' });
      }

      const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
      const contentBuffer = truncated
        ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
        : previewBuffer;

      const likelyBinaryType = contentType === 'application/pdf'
        || contentType === 'application/octet-stream';
      const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
      const likelyTextType = isLikelyTextContentType(contentType);

      let kind = workspacePreviewKindForMeta(ext, contentType);
      if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
        kind = 'binary';
      } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
        kind = 'binary';
      }

      const normalizedWebPath = toDriveWebPath(filePath);
      const payload = {
        ok: true,
        path: normalizedWebPath,
        name: path.win32.basename(filePath),
        kind,
        language,
        contentType,
        size,
        truncated,
        previewBytes: contentBuffer.length,
        rawUrl: `${remotePath}/api/drives/file?path=${encodeURIComponent(normalizedWebPath)}`,
      };

      if (kind !== 'binary' && kind !== 'image') {
        payload.content = contentBuffer.toString('utf8');
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    });
  });

  // POST /api/message — browser sends a message
  app.post('/api/message', auth, (req, res) => {
    const { messageId: clientMessageId, clientId, conversationId, text, newConversation, model, relayMode, mode, attachments: rawAttachments } = req.body;
    const sessionId = clientId || ensureSessionId(req, res);
    const trimmedText = String(text || '').trim();
    const normalizedAttachments = normalizeAttachments(rawAttachments);
    const referenceResolution = collectReferenceAttachmentsFromText(trimmedText);
    const attachments = mergeMessageAttachments(normalizedAttachments, referenceResolution.attachments);

    if (trimmedText.toLowerCase() === '/compact') {
      if (attachments.length) return res.status(400).json({ error: 'Compact command does not accept attachments' });
      if (!conversationId) return res.status(400).json({ error: 'Compact command requires an existing conversation' });
      const compacted = createCompactedConversation(conversationId);
      if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
      io.emit('conversation_compacted', compacted);
      return res.json({
        ok: true,
        command: 'compact',
        compacted: true,
        sourceConversationId: compacted.sourceConversationId,
        conversationId: compacted.targetConversationId,
        compactedConversationId: compacted.targetConversationId,
        runtimeSessionId: compacted.runtimeSessionId,
        summarySeedPreview: compacted.summarySeed.slice(0, 240),
      });
    }

    if (!trimmedText && attachments.length === 0) return res.status(400).json({ error: 'Empty message' });
    const modelResolution = resolveRequestedModel(model);
    if (!modelResolution.ok) return res.status(400).json({ error: modelResolution.error, supportedModels: modelResolution.available || [] });
    const requestedModel = modelResolution.model;
    const requestedRelayMode = normalizeRelayMode(relayMode || mode);
    if (!requestedRelayMode) return res.status(400).json({ error: 'Unsupported relay mode' });
    const workspaceRootUpdate = attachments.length === 0
      ? maybeApplyWorkspaceRootFromMessage(trimmedText)
      : { attempted: false, changed: false };

    const convId = (newConversation || !conversationId) ? uuidv4() : conversationId;
    getOrCreateConversation(convId, trimmedText || attachmentSummary(attachments) || 'Image');
    const convSeed = stmts.getConvSeed.get(convId);
    const shouldApplySeed = Number(convSeed?.seed_pending || 0) > 0 && String(convSeed?.summary_seed || '').trim().length > 0;

    const now   = new Date().toISOString();
    const runtimeSession = ensureRuntimeSessionBinding(convId, requestedModel, now);
    const msgId = clientMessageId || uuidv4();
    const queueText = shouldApplySeed
      ? [
          '[Carry-over context from previous compacted conversation]',
          String(convSeed.summary_seed).trim(),
          '',
          '[New user request]',
          trimmedText || '(User sent image attachments only.)',
        ].join('\n')
      : trimmedText;

    stmts.insertMsg.run(msgId, convId, 'user', trimmedText, requestedModel, requestedRelayMode, attachments.length ? JSON.stringify(attachments) : null, now);
    linkUploadReferences(convId, msgId, attachments);
    stmts.updateConvTime.run(now, convId);
    stmts.insertQ.run(msgId, convId, runtimeSession?.id || null, (!conversationId || !!newConversation) ? 1 : 0, requestedModel, requestedRelayMode, queueText, attachments.length ? JSON.stringify(attachments) : null, now);
    if (shouldApplySeed) {
      stmts.clearConvSeed.run(now, convId);
    }

    console.log(`[${ts()}] QUEUED    ${msgId.slice(0,8)} conv=${convId.slice(0,8)} rs=${String(runtimeSession?.id || 'none').slice(0,8)} new=${!conversationId || !!newConversation} model=${requestedModel} mode=${requestedRelayMode} text="${trimmedText.slice(0,60)}"${shouldApplySeed ? ' seeded=1' : ''}${attachments.length ? ` attachments=${attachments.length}` : ''}`);

    emitToClientsExceptSessionId(
      'user_message',
      { conversationId: convId, messageId: msgId, senderClientId: sessionId, message: { role: 'user', text: trimmedText, model: requestedModel, mode: requestedRelayMode, timestamp: now, attachments } },
      sessionId,
    );
    io.emit('message_status', { messageId: msgId, conversationId: convId, status: 'pending' });
    if (workspaceRootUpdate.changed) {
      io.emit('workspace_root_changed', {
        source: 'chat-cd-command',
        commandTarget: workspaceRootUpdate.target || null,
        ...workspaceRootPayload(),
      });
    }

    res.json({
      ok: true,
      messageId: msgId,
      conversationId: convId,
      runtimeSessionId: runtimeSession?.id || null,
      warning: modelResolution.warning || null,
      workspaceRootWarning: workspaceRootUpdate.error || null,
      workspaceRootChanged: !!workspaceRootUpdate.changed,
      ...workspaceRootPayload(),
      referenceAttachmentCount: referenceResolution.attachments.length,
      skippedReferenceAttachments: referenceResolution.skipped,
    });
  });

  app.post('/api/heartbeat', auth, (req, res) => {
    touchCli();
    const { pendingCount } = queueCounts();
    res.json({ ok: true, pendingCount });
  });

  // GET /api/pending — CLI fetches next pending message
  app.get('/api/pending', auth, (req, res) => {
    touchCli();
    if (runtimeState.relayPaused) return res.json({ message: null, paused: true });

    const dequeue = db.transaction(() => {
      const now = new Date().toISOString();
      const msg = stmts.findPending.get(now);
      if (!msg) return null;
      stmts.setProcessing.run(now, msg.id);
      return { ...msg, status: 'processing', processing_at: now };
    });

    const msg = dequeue();
    if (msg) {
      const attachments = parseAttachments(msg.attachments).map(hydrateAttachment).filter(Boolean);
      let runtimeSession = msg.runtime_session_id
        ? stmts.getRuntimeSessionById.get(msg.runtime_session_id)
        : null;
      if (!runtimeSession) {
        const now = new Date().toISOString();
        runtimeSession = ensureRuntimeSessionBinding(
          msg.conversation_id,
          String(msg.model || '').trim() || null,
          now,
        );
        if (runtimeSession?.id && runtimeSession.id !== msg.runtime_session_id) {
          stmts.setQueueRuntimeSession.run(runtimeSession.id, msg.id);
        }
      }
      // Normalise snake_case → camelCase for the relay
      const out = {
        id:                msg.id,
        conversationId:    msg.conversation_id,
        runtimeSessionId:  runtimeSession?.id || null,
        isNewConversation: msg.is_new_conversation === 1,
        model:             String(msg.model || '').trim() || getModelCatalogState().currentModel || DEFAULT_MODEL,
        relayMode:         normalizeRelayMode(msg.relay_mode) || DEFAULT_RELAY_MODE,
        text:              msg.text,
        attachments,
        conversationSessionMode: configuredConversationSessionMode,
        status:            msg.status,
        timestamp:         msg.timestamp,
        processingAt:      msg.processing_at,
      };
      console.log(`[${ts()}] DEQUEUED  ${out.id.slice(0,8)} conv=${out.conversationId.slice(0,8)} rs=${String(out.runtimeSessionId || 'none').slice(0,8)} model=${out.model} mode=${out.relayMode} text="${out.text.slice(0,60)}"${attachments.length ? ` attachments=${attachments.length}` : ''}`);
      io.emit('message_status', { messageId: out.id, conversationId: out.conversationId, status: 'processing' });
      res.json({ message: out });
    } else {
      res.json({ message: null });
    }
  });

  app.post('/api/relay/pause', auth, (req, res) => {
    runtimeState.relayPaused = true;
    const rows = stmts.listQueueForPauseDrop.all();
    const dropQueue = db.transaction(() => {
      for (const row of rows) {
        stmts.deleteQueueById.run(row.id);
      }
    });
    dropQueue();

    for (const row of rows) {
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'dropped' });
    }

    io.emit('relay_pause_state', { paused: true, droppedCount: rows.length });
    console.log(`[${ts()}] RELAY     paused dropped=${rows.length}`);
    res.json({ ok: true, paused: true, droppedCount: rows.length });
  });

  app.post('/api/relay/resume', auth, (req, res) => {
    runtimeState.relayPaused = false;
    io.emit('relay_pause_state', { paused: false });
    console.log(`[${ts()}] RELAY     resumed`);
    res.json({ ok: true, paused: false });
  });

  app.post('/api/relay/recover-processing', auth, (req, res) => {
    const rawMaxAge = Number(req.body?.maxAgeMs);
    const maxAgeMs = Number.isFinite(rawMaxAge)
      ? Math.max(5_000, Math.min(300_000, rawMaxAge))
      : 15_000;
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const requeueAt = addMsIso(5_000);
    const rows = recoverProcessingOlderThan(cutoff, requeueAt);
    if (!rows.length) return res.json({ ok: true, recovered: 0, maxAgeMs });
    console.log(`[${ts()}] RELAY     recovered processing=${rows.length} maxAgeMs=${maxAgeMs}`);
    return res.json({ ok: true, recovered: rows.length, maxAgeMs });
  });

  // POST /api/response — CLI submits response
  app.post('/api/response', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, model, mode } = req.body;

    if (!text?.trim()) return res.status(400).json({ error: 'Empty response' });
    if (!messageId) return res.status(400).json({ error: 'Missing messageId' });

    const q = stmts.findQById.get(messageId);
    const targetConversationId = q?.conversation_id || conversationId;
    if (!targetConversationId) return res.status(400).json({ error: 'Missing conversationId' });

    if (q && q.status === 'done') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_done`);
      return res.json({ ok: true, ignored: 'already_done' });
    }
    if (q && q.status === 'failed') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_failed`);
      return res.json({ ok: true, ignored: 'already_failed' });
    }

    const responseId = uuidv4();
    const now        = new Date().toISOString();
    const relayMode = normalizeRelayMode(mode || q?.relay_mode) || DEFAULT_RELAY_MODE;
    const finalize = db.transaction(() => {
      const result = stmts.setDone.run(text, messageId);
      if (result.changes === 0) return false;
      stmts.insertMsg.run(responseId, targetConversationId, 'assistant', text, model || null, relayMode, null, now);
      stmts.linkActivityToResponse.run(responseId, messageId);
      stmts.updateConvTime.run(now, targetConversationId);
      stmts.pruneQueue.run();
      return true;
    });

    const finalized = finalize();
    if (!finalized) {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=not_pending_or_processing`);
      return res.json({ ok: true, ignored: 'not_pending_or_processing' });
    }
    if (q?.runtime_session_id) {
      const nowIso = new Date().toISOString();
      const existing = stmts.getRuntimeSessionById.get(q.runtime_session_id);
      if (existing?.id) {
        stmts.touchRuntimeSession.run(
          String(model || existing.model || '').trim() || null,
          nowIso,
          existing.id,
        );
      }
    }
    const activities = relayActivityForResponse(responseId);

    console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} conv=${targetConversationId?.slice(0,8)} mode=${relayMode} len=${text.length} preview="${text.slice(0,60)}"`);

    io.emit('assistant_message', {
      conversationId: targetConversationId,
      sourceMessageId: messageId,
      messageId: responseId,
      message: { role: 'assistant', text, model: model || null, mode: relayMode, timestamp: now, activities },
    });
    io.emit('message_status', { messageId, conversationId: targetConversationId, status: 'done' });

    res.json({ ok: true });
  });

  // POST /api/activity — relay sends in-flight activity updates (tool/search sections)
  app.post('/api/activity', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, mode } = req.body || {};
    const activityText = sanitizeActivityText(text);
    if (!messageId || !conversationId || !activityText) {
      return res.status(400).json({ error: 'Missing activity payload' });
    }

    stmts.insertActivity.run(
      messageId,
      conversationId,
      normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      activityText,
      new Date().toISOString(),
    );

    io.emit('relay_activity', {
      messageId,
      conversationId,
      mode: normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      text: activityText,
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // POST /api/requeue — relay re-queues a message it failed to process
  app.post('/api/requeue', auth, (req, res) => {
    const { messageId } = req.body;
    const q = stmts.findQById.get(messageId);
    if (q && q.status === 'processing') {
      const retryCount = Number(q.retry_count || 0) + 1;
      if (retryCount >= MAX_REQUEUE_RETRIES) {
        const now = new Date().toISOString();
        const failText = `Relay timeout after ${retryCount} attempts. Message was skipped to keep the queue moving.`;
        const failResponse = JSON.stringify({ error: 'timeout', retryCount, failedAt: now });
        const responseId = uuidv4();
        const tx = db.transaction(() => {
          stmts.setFailed.run(failResponse, messageId);
          stmts.insertMsg.run(responseId, q.conversation_id, 'assistant', failText, q.model || null, normalizeRelayMode(q.relay_mode) || DEFAULT_RELAY_MODE, null, now);
          stmts.updateConvTime.run(now, q.conversation_id);
        });
        tx();
        console.log(`[${ts()}] FAILED    ${messageId?.slice(0,8)} retry=${retryCount} reason=timeout`);
        io.emit('assistant_message', {
          conversationId: q.conversation_id,
          messageId: responseId,
          message: {
            role: 'assistant',
            text: failText,
            model: q.model || null,
            mode: normalizeRelayMode(q.relay_mode) || DEFAULT_RELAY_MODE,
            timestamp: now,
          },
        });
        io.emit('message_status', { messageId, conversationId: q?.conversation_id, status: 'failed' });
      } else {
        const nextAttemptAt = addMsIso(computeRetryDelayMs(retryCount));
        const result = db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, retry_count = ?, next_attempt_at = ? WHERE id = ? AND status = 'processing'`).run(retryCount, nextAttemptAt, messageId);
        if (result.changes > 0) {
          console.log(`[${ts()}] REQUEUED  ${messageId?.slice(0,8)} retry=${retryCount} next=${nextAttemptAt}`);
          io.emit('message_status', { messageId, conversationId: q?.conversation_id, status: 'pending' });
        }
      }
    }
    res.json({ ok: true });
  });
}
