/**
 * Admin endpoints for file management, user permissions, and B-Integrity Recovery
 */
import express from 'express';
import { Op } from 'sequelize';
import { User, FilePermission, SearchHistory, Violation, IntegrityCycleSnapshot, SystemSnapshot, ResearchSession, ResearchLoopRun, JustificationTemplate, DoEDesign, sequelize } from './database.js';
import { getCurrentUser } from './authEndpoints.js';
import RAGService from './ragService.js';
import { getDefaultRules, getConditionTypes } from './integrityRulesEngine.js';
import { invalidateCache as invalidateJustificationCache } from './justificationTemplates.js';
import { runLoop } from './researchLoop.js';
import { evaluateRisks } from './riskOracle.js';
import { getFilWarnings } from './filLayer.js';
import logger from './logger.js';

const router = express.Router();

// Lazy initialization of RAG service
let _ragService = null;

function getRagService() {
  /**Get or initialize RAG service (lazy initialization)*/
  if (!_ragService) {
    logger.info("Initializing RAG service for admin...");
    _ragService = new RAGService();
    logger.info("RAG service initialized");
  }
  return _ragService;
}

/**
 * Middleware to verify that the current user is an admin
 */
async function verifyAdmin(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  
  // Check both is_admin flag and username
  if (!(user.is_admin || user.username === "admin")) {
    return res.status(403).json({ error: "Admin access required" });
  }
  
  req.user = user;
  next();
}

/**
 * Get all files in the database (admin only)
 */
router.get("/files", verifyAdmin, async (req, res) => {
  try {
    const ragService = getRagService();
    const filenames = await ragService.getAllFilenames();
    return res.json({
      files: filenames,
      count: filenames.length
    });
  } catch (e) {
    logger.error(`Error getting files: ${e.message}`);
    return res.status(500).json({ error: `Error getting files: ${e.message}` });
  }
});

/**
 * Delete a file and all its chunks from the database (admin only)
 */
router.delete("/files/:filename", verifyAdmin, async (req, res) => {
  try {
    const { filename } = req.params;
    const ragService = getRagService();
    // Delete documents with matching filename in metadata
    const result = await ragService.vectorStore.deleteDocuments(
      null,
      { filename: filename }
    );
    return res.json({
      success: true,
      message: `File '${filename}' deleted successfully`,
      deleted_count: result.deleted_count || 0
    });
  } catch (e) {
    logger.error(`Error deleting file: ${e.message}`);
    return res.status(500).json({ error: `Error deleting file: ${e.message}` });
  }
});

/**
 * Get all users (admin only)
 */
router.get("/users", verifyAdmin, async (req, res) => {
  try {
    const users = await User.findAll();
    return res.json({
      users: users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        is_active: user.is_active,
        is_admin: user.is_admin,
        created_at: user.created_at ? user.created_at.toISOString() : null
      })),
      count: users.length
    });
  } catch (e) {
    logger.error(`Error getting users: ${e.message}`);
    return res.status(500).json({ error: `Error getting users: ${e.message}` });
  }
});

/**
 * Get file permissions for a specific user (admin only)
 */
router.get("/users/:user_id/permissions", verifyAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);
    const targetUser = await User.findByPk(userId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Check if user has a special "access_all" permission (no specific file permissions = access all)
    const permissions = await FilePermission.findAll({
      where: { user_id: userId }
    });
    
    // If no permissions exist, user has access to all files
    const accessAllFiles = permissions.length === 0;
    const allowedFiles = accessAllFiles ? [] : permissions.map(p => p.filename);
    
    return res.json({
      user_id: targetUser.id,
      username: targetUser.username,
      access_all_files: accessAllFiles,
      allowed_files: allowedFiles
    });
  } catch (e) {
    logger.error(`Error getting user permissions: ${e.message}`);
    return res.status(500).json({ error: `Error getting user permissions: ${e.message}` });
  }
});

/**
 * Set file permissions for a specific user (admin only)
 */
router.post("/users/:user_id/permissions", verifyAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);
    const { access_all_files, allowed_files } = req.body;
    
    if (access_all_files === undefined) {
      return res.status(400).json({ error: "access_all_files is required" });
    }
    
    if (!Array.isArray(allowed_files)) {
      return res.status(400).json({ error: "allowed_files must be a list" });
    }
    
    const targetUser = await User.findByPk(userId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Delete existing permissions
    await FilePermission.destroy({ where: { user_id: userId } });
    
    // If access_all_files is True, don't add any permissions (empty list = access all)
    // If False, add permissions for each allowed file
    if (!access_all_files && allowed_files && allowed_files.length > 0) {
      for (const filename of allowed_files) {
        await FilePermission.create({
          user_id: userId,
          filename: filename
        });
      }
    }
    
    return res.json({
      success: true,
      message: `Permissions updated for user ${targetUser.username}`,
      user_id: targetUser.id,
      access_all_files: access_all_files,
      allowed_files: allowed_files || []
    });
  } catch (e) {
    logger.error(`Error setting user permissions: ${e.message}`);
    return res.status(500).json({ error: `Error setting user permissions: ${e.message}` });
  }
});

/**
 * Get all search history - questions and answers from all users (admin only)
 */
router.get("/search-history", verifyAdmin, async (req, res) => {
  try {
    if (!SearchHistory) {
      return res.json({ history: [], count: 0 });
    }
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const history = await SearchHistory.findAll({
      order: [['created_at', 'DESC']],
      limit
    });
    return res.json({
      history: history.map(h => ({
        id: h.id,
        user_id: h.user_id,
        username: h.username || 'אורח',
        question: h.question,
        answer: h.answer,
        created_at: h.created_at ? h.created_at.toISOString() : null
      })),
      count: history.length
    });
  } catch (e) {
    logger.error(`Error getting search history: ${e.message}`);
    return res.status(500).json({ error: `Error getting search history: ${e.message}` });
  }
});

// ---------- Global Metrics (admin only) ----------

/**
 * Global aggregate metrics for the system. Admin only.
 */
router.get("/metrics/global", verifyAdmin, async (req, res) => {
  try {
    const [
      usersCount,
      researchSessionsCount,
      searchHistoryCount,
      cycleSnapshotsCount,
      violationsTotal,
      violationsActive,
      snapshotsCount,
      researchLoopRunsCount
    ] = await Promise.all([
      User.count().catch(() => 0),
      ResearchSession ? ResearchSession.count().catch(() => 0) : 0,
      SearchHistory ? SearchHistory.count().catch(() => 0) : 0,
      IntegrityCycleSnapshot ? IntegrityCycleSnapshot.count().catch(() => 0) : 0,
      Violation ? Violation.count().catch(() => 0) : 0,
      Violation ? Violation.count({ where: { resolved_at: null } }).catch(() => 0) : 0,
      SystemSnapshot ? SystemSnapshot.count().catch(() => 0) : 0,
      ResearchLoopRun ? ResearchLoopRun.count().catch(() => 0) : 0
    ]);

    let documentCount = 0;
    try {
      const info = await getRagService().getCollectionInfo();
      documentCount = (info && info.document_count) || 0;
    } catch (e) {
      logger.warn(`Global metrics getCollectionInfo: ${e.message}`);
    }

    return res.json({
      users: usersCount,
      research_sessions: researchSessionsCount,
      search_history_entries: searchHistoryCount,
      integrity_cycle_snapshots: cycleSnapshotsCount,
      violations_total: violationsTotal,
      violations_active: violationsActive,
      violations_resolved: violationsTotal - violationsActive,
      system_snapshots: snapshotsCount,
      research_loop_runs: researchLoopRunsCount,
      document_count: documentCount
    });
  } catch (e) {
    logger.error(`Error getting global metrics: ${e.message}`);
    return res.status(500).json({ error: `Error getting global metrics: ${e.message}` });
  }
});

// ---------- B-Integrity Recovery API ----------

/**
 * Dashboard data for B-Integrity: status, chart series, violations. Admin only.
 * Query: limit, from_date, to_date (ISO), violation_status (all|active|resolved), violation_type.
 */
router.get("/recovery/dashboard", verifyAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const fromDate = req.query.from_date ? new Date(req.query.from_date) : null;
    const toDate = req.query.to_date ? new Date(req.query.to_date) : null;
    const violationStatus = (req.query.violation_status || 'all').toLowerCase();
    const violationType = (req.query.violation_type || '').trim() || null;

    let currentM = 0;
    try {
      const info = await getRagService().getCollectionInfo();
      currentM = (info && info.document_count) || 0;
    } catch (e) {
      logger.warn(`Dashboard getCollectionInfo failed: ${e.message}`);
    }

    let totalCycles = 0;
    let chartPoints = [];
    let lastResolvedAt = null;

    const snapshotWhere = {};
    if (fromDate && !isNaN(fromDate.getTime())) snapshotWhere[Op.gte] = fromDate;
    if (toDate && !isNaN(toDate.getTime())) {
      snapshotWhere[Op.lte] = toDate;
      if (!snapshotWhere[Op.gte]) snapshotWhere[Op.gte] = new Date(0);
    }
    const snapshotDateFilter = Object.keys(snapshotWhere).length > 0 ? { created_at: snapshotWhere } : {};

    if (IntegrityCycleSnapshot) {
      const countResult = await IntegrityCycleSnapshot.count();
      totalCycles = countResult || 0;
      const snapshotOpts = {
        order: [['created_at', 'ASC']],
        limit
      };
      if (Object.keys(snapshotDateFilter).length) snapshotOpts.where = snapshotDateFilter;
      const snapshots = await IntegrityCycleSnapshot.findAll(snapshotOpts);
      chartPoints = snapshots.map(s => ({
        t: s.created_at ? s.created_at.toISOString() : null,
        value: s.metric_value,
        session_id: s.session_id,
        cycle_index: s.cycle_index
      }));
    }

    const violationWhere = {};
    if (violationStatus === 'active') violationWhere.resolved_at = null;
    else if (violationStatus === 'resolved') violationWhere.resolved_at = { [Op.ne]: null };
    if (violationType) violationWhere.type = violationType;
    if ((fromDate && !isNaN(fromDate.getTime())) || (toDate && !isNaN(toDate.getTime()))) {
      violationWhere.created_at = {};
      if (fromDate && !isNaN(fromDate.getTime())) violationWhere.created_at[Op.gte] = fromDate;
      if (toDate && !isNaN(toDate.getTime())) violationWhere.created_at[Op.lte] = toDate;
    }

    let violationsList = [];
    let activeCount = 0;
    let allViolationsForStatus = [];

    if (Violation) {
      const allViolations = await Violation.findAll({
        order: [['created_at', 'DESC']],
        limit: 500
      });
      allViolationsForStatus = allViolations;
      activeCount = allViolations.filter(v => !v.resolved_at).length;

      const filterOpts = {
        order: [['created_at', 'DESC']],
        limit: 200
      };
      if (Object.keys(violationWhere).length) filterOpts.where = violationWhere;
      const filteredViolations = await Violation.findAll(filterOpts);
      violationsList = filteredViolations.map(v => ({
        id: v.id,
        session_id: v.session_id,
        type: v.type,
        reason: v.reason,
        details: v.details,
        created_at: v.created_at ? v.created_at.toISOString() : null,
        resolved_at: v.resolved_at ? v.resolved_at.toISOString() : null,
        resolved_by: v.resolved_by,
        resolve_note: v.resolve_note
      }));

      const resolved = allViolationsForStatus.filter(v => v.resolved_at);
      if (resolved.length > 0) {
        const latest = resolved.reduce((a, b) => (a.resolved_at > b.resolved_at ? a : b));
        lastResolvedAt = latest.resolved_at ? latest.resolved_at.toISOString() : null;
      }
    }

    let cyclesSinceLastClosure = totalCycles;
    if (lastResolvedAt && IntegrityCycleSnapshot) {
      const afterClosure = await IntegrityCycleSnapshot.count({
        where: { created_at: { [Op.gt]: new Date(lastResolvedAt) } }
      });
      cyclesSinceLastClosure = afterClosure;
    }

    let gateStatus = 'HEALTHY';
    if (activeCount > 0) gateStatus = 'HALTED';
    else if (allViolationsForStatus.some(v => v.resolved_at)) gateStatus = 'RECOVERY';

    const chartViolations = (violationsList || []).filter(v => v.created_at).map(v => ({
      id: v.id,
      t: v.created_at,
      reason: v.reason
    }));

    return res.json({
      gate_status: gateStatus,
      current_cycle: totalCycles,
      current_m: currentM,
      cycles_since_last_closure: cyclesSinceLastClosure,
      chart: {
        points: chartPoints,
        violations: chartViolations
      },
      violations: violationsList
    });
  } catch (e) {
    logger.error(`Error getting recovery dashboard: ${e.message}`);
    return res.status(500).json({ error: `Error getting recovery dashboard: ${e.message}` });
  }
});

/**
 * List Integrity Rules engine: active rules and available condition types. Admin only.
 */
router.get("/recovery/rules", verifyAdmin, async (req, res) => {
  try {
    const rules = getDefaultRules().map(({ id, condition, action, reason }) => ({
      id,
      condition: { type: condition.type, params: condition.params },
      action,
      reason
    }));
    const conditionTypes = getConditionTypes();
    return res.json({ rules, conditionTypes });
  } catch (e) {
    logger.error(`Error getting recovery rules: ${e.message}`);
    return res.status(500).json({ error: `Error getting recovery rules: ${e.message}` });
  }
});

/**
 * Risk Oracle – predicted/assessed risks from current integrity state. Warnings only; does not block endpoints. Admin only.
 * Query: session_id (optional) – if provided, evaluate for that session only; otherwise global.
 */
router.get("/recovery/oracle", verifyAdmin, async (req, res) => {
  try {
    const sessionId = req.query.session_id?.trim?.() || null;
    const result = await evaluateRisks(sessionId);
    return res.json(result);
  } catch (e) {
    logger.error(`Error getting recovery oracle: ${e.message}`);
    return res.status(500).json({ error: `Error getting recovery oracle: ${e.message}` });
  }
});

/** Alias for dashboard: GET /admin/risk-oracle (same as /admin/recovery/oracle) */
router.get("/risk-oracle", verifyAdmin, async (req, res) => {
  try {
    const sessionId = req.query.session_id?.trim?.() || null;
    const result = await evaluateRisks(sessionId);
    return res.json(result);
  } catch (e) {
    logger.error(`Error getting risk oracle: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * FIL-01 (Failure Intelligence Layer) – pattern mining from violations. Warnings only; no Hard Stop change. Admin only.
 * GET /admin/fil/warnings?days=30&session_id=&limit=100
 */
router.get("/fil/warnings", verifyAdmin, async (req, res) => {
  try {
    const result = await getFilWarnings({
      session_id: req.query.session_id?.trim?.() || null,
      days: req.query.days,
      limit: req.query.limit
    });
    return res.json(result);
  } catch (e) {
    logger.error(`Error getting FIL warnings: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

// ---------- System Snapshots (save/restore state) ----------

/** Build current integrity payload (for backup/snapshot). */
async function captureIntegrityPayload() {
  let integritySnapshots = [];
  let violations = [];
  if (IntegrityCycleSnapshot) {
    const rows = await IntegrityCycleSnapshot.findAll({ order: [['created_at', 'ASC']] });
    integritySnapshots = rows.map(s => ({
      session_id: s.session_id,
      stage: s.stage,
      cycle_index: s.cycle_index,
      metric_name: s.metric_name,
      metric_value: s.metric_value,
      details: s.details,
      created_at: s.created_at ? s.created_at.toISOString() : null
    }));
  }
  if (Violation) {
    const rows = await Violation.findAll({ order: [['created_at', 'ASC']] });
    violations = rows.map(v => ({
      session_id: v.session_id,
      type: v.type,
      reason: v.reason,
      details: v.details,
      created_at: v.created_at ? v.created_at.toISOString() : null,
      resolved_at: v.resolved_at ? v.resolved_at.toISOString() : null,
      resolved_by: v.resolved_by,
      resolve_note: v.resolve_note
    }));
  }
  return { integrity_cycle_snapshots: integritySnapshots, violations };
}

/**
 * Create a snapshot of current integrity state. Admin only.
 * Body: { name: string, description?: string, type?: 'integrity' | 'full' }
 * For type 'integrity': saves all IntegrityCycleSnapshot and Violation rows (without ids for clean restore).
 */
router.post("/snapshots", verifyAdmin, async (req, res) => {
  try {
    if (!SystemSnapshot || !IntegrityCycleSnapshot || !Violation) {
      return res.status(503).json({ error: "Snapshot storage or integrity models not available" });
    }
    const name = req.body?.name?.trim?.() || `snapshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
    const description = req.body?.description?.trim?.() || null;
    const snapshotType = (req.body?.type === 'full') ? 'full' : 'integrity';
    const userId = req.user?.id ?? null;

    const { integrity_cycle_snapshots: integritySnapshots, violations } = await captureIntegrityPayload();
    const payload = { integrity_cycle_snapshots: integritySnapshots, violations };

    const snap = await SystemSnapshot.create({
      name,
      description,
      snapshot_type: snapshotType,
      payload,
      created_by: userId
    });
    return res.status(201).json({
      id: snap.id,
      name: snap.name,
      description: snap.description,
      snapshot_type: snap.snapshot_type,
      created_at: snap.created_at ? snap.created_at.toISOString() : null,
      created_by: snap.created_by,
      counts: { integrity_cycle_snapshots: integritySnapshots.length, violations: violations.length }
    });
  } catch (e) {
    logger.error(`Error creating snapshot: ${e.message}`);
    return res.status(500).json({ error: `Error creating snapshot: ${e.message}` });
  }
});

/**
 * List snapshots. Admin only.
 */
router.get("/snapshots", verifyAdmin, async (req, res) => {
  try {
    if (!SystemSnapshot) return res.json({ snapshots: [], count: 0 });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const list = await SystemSnapshot.findAll({
      order: [['created_at', 'DESC']],
      limit,
      attributes: ['id', 'name', 'description', 'snapshot_type', 'created_at', 'created_by']
    });
    return res.json({
      snapshots: list.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        snapshot_type: s.snapshot_type,
        created_at: s.created_at ? s.created_at.toISOString() : null,
        created_by: s.created_by
      })),
      count: list.length
    });
  } catch (e) {
    logger.error(`Error listing snapshots: ${e.message}`);
    return res.status(500).json({ error: `Error listing snapshots: ${e.message}` });
  }
});

/**
 * Get one snapshot (includes payload for restore). Admin only.
 */
router.get("/snapshots/:id", verifyAdmin, async (req, res) => {
  try {
    if (!SystemSnapshot) return res.status(503).json({ error: "Snapshot storage not available" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid snapshot id" });
    const snap = await SystemSnapshot.findByPk(id);
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });
    return res.json({
      id: snap.id,
      name: snap.name,
      description: snap.description,
      snapshot_type: snap.snapshot_type,
      created_at: snap.created_at ? snap.created_at.toISOString() : null,
      created_by: snap.created_by,
      payload: snap.payload,
      counts: snap.payload ? {
        integrity_cycle_snapshots: (snap.payload.integrity_cycle_snapshots || []).length,
        violations: (snap.payload.violations || []).length
      } : null
    });
  } catch (e) {
    logger.error(`Error getting snapshot: ${e.message}`);
    return res.status(500).json({ error: `Error getting snapshot: ${e.message}` });
  }
});

/**
 * Restore state from a snapshot. Admin only.
 * Query or body: backup_before_restore=true to create a snapshot of current state first (enables rollback).
 * Replaces all current integrity cycle snapshots and violations with the snapshot data.
 */
router.post("/snapshots/:id/restore", verifyAdmin, async (req, res) => {
  try {
    if (!SystemSnapshot || !IntegrityCycleSnapshot || !Violation || !sequelize) {
      return res.status(503).json({ error: "Snapshot or integrity models not available" });
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid snapshot id" });
    const backupBeforeRestore = req.query.backup_before_restore === 'true' || req.body?.backup_before_restore === true;
    const userId = req.user?.id ?? null;

    let backupSnapshotId = null;
    if (backupBeforeRestore) {
      const payload = await captureIntegrityPayload();
      const backupName = `pre-restore-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
      const backupSnap = await SystemSnapshot.create({
        name: backupName,
        description: 'Auto backup before restore (use for rollback)',
        snapshot_type: 'integrity',
        payload,
        created_by: userId
      });
      backupSnapshotId = backupSnap.id;
      logger.info(`Recovery: backup created before restore, snapshot_id=${backupSnapshotId}`);
    }

    const snap = await SystemSnapshot.findByPk(id);
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });
    const payload = snap.payload || {};
    const integritySnapshots = payload.integrity_cycle_snapshots || [];
    const violations = payload.violations || [];

    const t = await sequelize.transaction();
    try {
      await Violation.destroy({ where: {}, transaction: t });
      await IntegrityCycleSnapshot.destroy({ where: {}, transaction: t });
      for (const row of integritySnapshots) {
        await IntegrityCycleSnapshot.create({
          session_id: row.session_id,
          stage: row.stage,
          cycle_index: row.cycle_index,
          metric_name: row.metric_name || 'document_count',
          metric_value: row.metric_value,
          details: row.details,
          ...(row.created_at && { created_at: new Date(row.created_at) })
        }, { transaction: t });
      }
      for (const row of violations) {
        await Violation.create({
          session_id: row.session_id,
          type: row.type || 'B_INTEGRITY',
          reason: row.reason,
          details: row.details,
          ...(row.created_at && { created_at: new Date(row.created_at) }),
          resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
          resolved_by: row.resolved_by ?? null,
          resolve_note: row.resolve_note ?? null
        }, { transaction: t });
      }
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }

    logger.info(`Snapshot ${id} restored: ${integritySnapshots.length} cycle snapshots, ${violations.length} violations`);
    const result = {
      success: true,
      snapshot_id: id,
      restored: { integrity_cycle_snapshots: integritySnapshots.length, violations: violations.length }
    };
    if (backupSnapshotId != null) result.backup_snapshot_id = backupSnapshotId;
    return res.json(result);
  } catch (e) {
    logger.error(`Error restoring snapshot: ${e.message}`);
    return res.status(500).json({ error: `Error restoring snapshot: ${e.message}` });
  }
});

/**
 * Rollback to a previous state by restoring a backup snapshot (e.g. the one created with backup_before_restore).
 * Body: { backup_snapshot_id: number }. Admin only.
 */
router.post("/recovery/rollback", verifyAdmin, async (req, res) => {
  try {
    const backupId = req.body?.backup_snapshot_id != null ? parseInt(String(req.body.backup_snapshot_id), 10) : null;
    if (backupId == null || isNaN(backupId)) {
      return res.status(400).json({ error: "backup_snapshot_id is required" });
    }
    if (!SystemSnapshot) return res.status(404).json({ error: "Snapshot not found" });
    const snap = await SystemSnapshot.findByPk(backupId);
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });
    const payload = snap.payload || {};
    const integritySnapshots = payload.integrity_cycle_snapshots || [];
    const violations = payload.violations || [];

    if (!IntegrityCycleSnapshot || !Violation || !sequelize) {
      return res.status(503).json({ error: "Integrity models not available" });
    }
    const t = await sequelize.transaction();
    try {
      await Violation.destroy({ where: {}, transaction: t });
      await IntegrityCycleSnapshot.destroy({ where: {}, transaction: t });
      for (const row of integritySnapshots) {
        await IntegrityCycleSnapshot.create({
          session_id: row.session_id,
          stage: row.stage,
          cycle_index: row.cycle_index,
          metric_name: row.metric_name || 'document_count',
          metric_value: row.metric_value,
          details: row.details,
          ...(row.created_at && { created_at: new Date(row.created_at) })
        }, { transaction: t });
      }
      for (const row of violations) {
        await Violation.create({
          session_id: row.session_id,
          type: row.type || 'B_INTEGRITY',
          reason: row.reason,
          details: row.details,
          ...(row.created_at && { created_at: new Date(row.created_at) }),
          resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
          resolved_by: row.resolved_by ?? null,
          resolve_note: row.resolve_note ?? null
        }, { transaction: t });
      }
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
    logger.info(`Recovery rollback: restored snapshot ${backupId}`);
    return res.json({
      success: true,
      rollback_snapshot_id: backupId,
      restored: { integrity_cycle_snapshots: integritySnapshots.length, violations: violations.length }
    });
  } catch (e) {
    logger.error(`Error during rollback: ${e.message}`);
    return res.status(500).json({ error: `Error during rollback: ${e.message}` });
  }
});

// ---------- Justification Templates ----------

/**
 * List justification templates. Admin only.
 */
router.get("/justification-templates", verifyAdmin, async (req, res) => {
  try {
    if (!JustificationTemplate) return res.json({ templates: [], count: 0 });
    const list = await JustificationTemplate.findAll({ order: [['reason_code', 'ASC']] });
    return res.json({
      templates: list.map(t => ({
        id: t.id,
        name: t.name,
        reason_code: t.reason_code,
        label: t.label,
        description: t.description,
        template_text: t.template_text,
        created_at: t.created_at ? t.created_at.toISOString() : null,
        updated_at: t.updated_at ? t.updated_at.toISOString() : null
      })),
      count: list.length
    });
  } catch (e) {
    logger.error(`Error listing justification templates: ${e.message}`);
    return res.status(500).json({ error: `Error listing justification templates: ${e.message}` });
  }
});

/**
 * Create a justification template. Admin only.
 * Body: { name, reason_code, label?, description?, template_text? }
 * Placeholders in template_text: {{agent}}, {{previous_snippet}}
 */
router.post("/justification-templates", verifyAdmin, async (req, res) => {
  try {
    if (!JustificationTemplate) return res.status(503).json({ error: "Justification templates not available" });
    const name = req.body?.name?.trim?.();
    const reasonCode = req.body?.reason_code?.trim?.();
    if (!name || !reasonCode) return res.status(400).json({ error: "name and reason_code are required" });
    const label = req.body?.label?.trim?.() || null;
    const description = req.body?.description?.trim?.() || null;
    const templateText = req.body?.template_text?.trim?.() || null;
    const t = await JustificationTemplate.create({
      name,
      reason_code: reasonCode,
      label,
      description,
      template_text: templateText
    });
    invalidateJustificationCache();
    return res.status(201).json({
      id: t.id,
      name: t.name,
      reason_code: t.reason_code,
      label: t.label,
      description: t.description,
      template_text: t.template_text,
      created_at: t.created_at ? t.created_at.toISOString() : null,
      updated_at: t.updated_at ? t.updated_at.toISOString() : null
    });
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: "reason_code already exists" });
    logger.error(`Error creating justification template: ${e.message}`);
    return res.status(500).json({ error: `Error creating justification template: ${e.message}` });
  }
});

/**
 * Update a justification template. Admin only.
 * Body: { name?, label?, description?, template_text? }
 */
router.patch("/justification-templates/:id", verifyAdmin, async (req, res) => {
  try {
    if (!JustificationTemplate) return res.status(503).json({ error: "Justification templates not available" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const t = await JustificationTemplate.findByPk(id);
    if (!t) return res.status(404).json({ error: "Template not found" });
    if (req.body?.name != null) t.name = req.body.name.trim?.() || t.name;
    if (req.body?.label !== undefined) t.label = req.body.label?.trim?.() || null;
    if (req.body?.description !== undefined) t.description = req.body.description?.trim?.() || null;
    if (req.body?.template_text !== undefined) t.template_text = req.body.template_text?.trim?.() || null;
    t.updated_at = new Date();
    await t.save();
    invalidateJustificationCache();
    return res.json({
      id: t.id,
      name: t.name,
      reason_code: t.reason_code,
      label: t.label,
      description: t.description,
      template_text: t.template_text,
      created_at: t.created_at ? t.created_at.toISOString() : null,
      updated_at: t.updated_at ? t.updated_at.toISOString() : null
    });
  } catch (e) {
    logger.error(`Error updating justification template: ${e.message}`);
    return res.status(500).json({ error: `Error updating justification template: ${e.message}` });
  }
});

/**
 * Delete a justification template. Admin only.
 */
router.delete("/justification-templates/:id", verifyAdmin, async (req, res) => {
  try {
    if (!JustificationTemplate) return res.status(503).json({ error: "Justification templates not available" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const t = await JustificationTemplate.findByPk(id);
    if (!t) return res.status(404).json({ error: "Template not found" });
    await t.destroy();
    invalidateJustificationCache();
    return res.json({ success: true, id });
  } catch (e) {
    logger.error(`Error deleting justification template: ${e.message}`);
    return res.status(500).json({ error: `Error deleting justification template: ${e.message}` });
  }
});

// ---------- DoE (Design of Experiments) integration ----------
router.get("/doe/export", verifyAdmin, async (req, res) => {
  try {
    if (!ResearchLoopRun) return res.status(503).json({ error: "Research loop runs not available" });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const format = (req.query.format || 'json').toLowerCase();
    const runs = await ResearchLoopRun.findAll({ order: [['created_at', 'DESC']], limit, attributes: ['id', 'session_id', 'query', 'outputs', 'justifications', 'pre_justification_text', 'doe_design_id', 'duration_ms', 'created_at'] });
    const rows = runs.map(r => ({
      run_id: r.id,
      session_id: r.session_id,
      query: r.query,
      synthesis_output: (r.outputs && r.outputs.synthesis) ? r.outputs.synthesis : '',
      pre_justification_text: r.pre_justification_text || null,
      doe_design_id: r.doe_design_id || null,
      duration_ms: r.duration_ms || null,
      created_at: r.created_at ? r.created_at.toISOString() : null
    }));
    if (format === 'csv') {
      const BOM = '\uFEFF';
      const headers = ['run_id', 'session_id', 'query', 'synthesis_output', 'pre_justification_text', 'doe_design_id', 'duration_ms', 'created_at'];
      const csv = [headers.join(','), ...rows.map(row => headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=doe-export-${new Date().toISOString().slice(0, 10)}.csv`);
      return res.send(BOM + csv);
    }
    return res.json({ runs: rows, count: rows.length });
  } catch (e) {
    logger.error(`Error exporting DoE data: ${e.message}`);
    return res.status(500).json({ error: `Error exporting DoE data: ${e.message}` });
  }
});
router.get("/doe/designs", verifyAdmin, async (req, res) => {
  try {
    if (!DoEDesign) return res.json({ designs: [], count: 0 });
    const list = await DoEDesign.findAll({ order: [['created_at', 'DESC']] });
    return res.json({ designs: list.map(d => ({ id: d.id, name: d.name, description: d.description, design: d.design, query_template: d.query_template, created_at: d.created_at ? d.created_at.toISOString() : null })), count: list.length });
  } catch (e) {
    logger.error(`Error listing DoE designs: ${e.message}`);
    return res.status(500).json({ error: `Error listing DoE designs: ${e.message}` });
  }
});
router.post("/doe/designs", verifyAdmin, async (req, res) => {
  try {
    if (!DoEDesign) return res.status(503).json({ error: "DoE designs not available" });
    const name = req.body?.name?.trim?.();
    if (!name) return res.status(400).json({ error: "name is required" });
    const design = Array.isArray(req.body?.design) ? req.body.design : [];
    const d = await DoEDesign.create({ name, description: req.body?.description?.trim?.() || null, design, query_template: req.body?.query_template?.trim?.() || null });
    return res.status(201).json({ id: d.id, name: d.name, description: d.description, design: d.design, query_template: d.query_template, created_at: d.created_at ? d.created_at.toISOString() : null });
  } catch (e) {
    logger.error(`Error creating DoE design: ${e.message}`);
    return res.status(500).json({ error: `Error creating DoE design: ${e.message}` });
  }
});
router.get("/doe/designs/:id", verifyAdmin, async (req, res) => {
  try {
    if (!DoEDesign) return res.status(503).json({ error: "DoE designs not available" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const d = await DoEDesign.findByPk(id);
    if (!d) return res.status(404).json({ error: "Design not found" });
    return res.json({ id: d.id, name: d.name, description: d.description, design: d.design, query_template: d.query_template, created_at: d.created_at ? d.created_at.toISOString() : null });
  } catch (e) {
    logger.error(`Error getting DoE design: ${e.message}`);
    return res.status(500).json({ error: `Error getting DoE design: ${e.message}` });
  }
});
router.patch("/doe/designs/:id", verifyAdmin, async (req, res) => {
  try {
    if (!DoEDesign) return res.status(503).json({ error: "DoE designs not available" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const d = await DoEDesign.findByPk(id);
    if (!d) return res.status(404).json({ error: "Design not found" });
    if (req.body?.name != null) d.name = req.body.name.trim?.() || d.name;
    if (req.body?.description !== undefined) d.description = req.body.description?.trim?.() || null;
    if (Array.isArray(req.body?.design)) d.design = req.body.design;
    if (req.body?.query_template !== undefined) d.query_template = req.body.query_template?.trim?.() || null;
    d.updated_at = new Date();
    await d.save();
    return res.json({ id: d.id, name: d.name, description: d.description, design: d.design, query_template: d.query_template, created_at: d.created_at ? d.created_at.toISOString() : null });
  } catch (e) {
    logger.error(`Error updating DoE design: ${e.message}`);
    return res.status(500).json({ error: `Error updating DoE design: ${e.message}` });
  }
});
router.delete("/doe/designs/:id", verifyAdmin, async (req, res) => {
  try {
    if (!DoEDesign) return res.status(503).json({ error: "DoE designs not available" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const d = await DoEDesign.findByPk(id);
    if (!d) return res.status(404).json({ error: "Design not found" });
    await d.destroy();
    return res.json({ success: true, id });
  } catch (e) {
    logger.error(`Error deleting DoE design: ${e.message}`);
    return res.status(500).json({ error: `Error deleting DoE design: ${e.message}` });
  }
});
function interpolateDoE(template, factors) {
  if (!template || typeof template !== 'string') return '';
  let out = template;
  for (const [key, value] of Object.entries(factors || {})) {
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), String(value ?? ''));
  }
  return out;
}
router.post("/doe/designs/:id/execute", verifyAdmin, async (req, res) => {
  try {
    if (!DoEDesign || !ResearchSession || !ResearchLoopRun) return res.status(503).json({ error: "DoE or research models not available" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const d = await DoEDesign.findByPk(id);
    if (!d) return res.status(404).json({ error: "Design not found" });
    const design = Array.isArray(d.design) ? d.design : [];
    if (design.length === 0) return res.status(400).json({ error: "Design has no runs" });
    let sessionId = req.body?.session_id;
    if (!sessionId) {
      const session = await ResearchSession.create({ user_id: req.user?.id ?? null, completed_stages: [] });
      sessionId = session.id;
    } else {
      const session = await ResearchSession.findByPk(sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
    }
    const ragService = getRagService();
    const queryTemplate = d.query_template && d.query_template.trim() ? d.query_template.trim() : null;
    const results = [];
    for (const row of design) {
      const factors = row.factors || row;
      const query = queryTemplate ? interpolateDoE(queryTemplate, factors) : JSON.stringify(factors);
      const result = await runLoop(sessionId, query, ragService, null, { doe_design_id: id });
      results.push({ run: row.run != null ? row.run : results.length + 1, factors, query, run_id: result.run_id, error: result.error || null });
    }
    return res.json({ success: true, design_id: id, session_id: sessionId, runs_executed: results.length, results });
  } catch (e) {
    logger.error(`Error executing DoE design: ${e.message}`);
    return res.status(500).json({ error: `Error executing DoE design: ${e.message}` });
  }
});

/**
 * List violations (active and/or resolved). Admin only.
 * Query: ?active_only=true to see only unresolved.
 */
router.get("/recovery/violations", verifyAdmin, async (req, res) => {
  try {
    if (!Violation) {
      return res.json({ violations: [], count: 0 });
    }
    const activeOnly = req.query.active_only === 'true';
    const where = activeOnly ? { resolved_at: null } : {};
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const violations = await Violation.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit
    });
    return res.json({
      violations: violations.map(v => ({
        id: v.id,
        session_id: v.session_id,
        type: v.type,
        reason: v.reason,
        details: v.details,
        created_at: v.created_at ? v.created_at.toISOString() : null,
        resolved_at: v.resolved_at ? v.resolved_at.toISOString() : null,
        resolved_by: v.resolved_by,
        resolve_note: v.resolve_note
      })),
      count: violations.length
    });
  } catch (e) {
    logger.error(`Error listing violations: ${e.message}`);
    return res.status(500).json({ error: `Error listing violations: ${e.message}` });
  }
});

/**
 * Create a test violation for a session (locks the gate). Admin only.
 * Body: { session_id: string, reason?: string, details?: object }
 * Used for proof/testing: create violation → GET /search and POST /api/research/run return locked → resolve → both work again.
 */
router.post("/recovery/violations", verifyAdmin, async (req, res) => {
  try {
    if (!Violation) return res.status(503).json({ error: "Violations storage not available" });
    const sessionId = req.body?.session_id?.trim?.();
    if (!sessionId) return res.status(400).json({ error: "session_id is required" });
    const reason = req.body?.reason?.trim?.() || 'B_INTEGRITY';
    const details = req.body?.details ?? null;
    const violation = await Violation.create({
      session_id: sessionId,
      type: 'B_INTEGRITY',
      reason,
      details: details ? (typeof details === 'object' ? details : { raw: details }) : null,
      resolved_at: null
    });
    logger.info(`Recovery: created test violation ${violation.id} for session ${sessionId}`);
    return res.status(201).json({
      violation_id: violation.id,
      session_id: violation.session_id,
      reason: violation.reason,
      message: "Violation created; gate locked for this session"
    });
  } catch (e) {
    logger.error(`Error creating violation: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * Resolve all active violations (bulk recovery). Admin only.
 * Body: { resolve_note?: string, session_id?: string } – optional session_id to resolve only that session's violations.
 */
router.post("/recovery/violations/resolve-all", verifyAdmin, async (req, res) => {
  try {
    if (!Violation) return res.status(503).json({ error: "Violations storage not available" });
    const resolveNote = req.body?.resolve_note?.trim?.() || null;
    const sessionId = req.body?.session_id?.trim?.() || null;
    const userId = req.user?.id ?? null;

    const where = { resolved_at: null };
    if (sessionId) where.session_id = sessionId;
    const active = await Violation.findAll({ where });
    const now = new Date();
    let resolved = 0;
    for (const v of active) {
      await v.update({
        resolved_at: now,
        resolved_by: userId,
        resolve_note: resolveNote
      });
      resolved++;
    }
    logger.info(`Recovery: resolve-all resolved ${resolved} violation(s)${sessionId ? ` for session ${sessionId}` : ''}`);
    return res.json({
      success: true,
      resolved,
      message: resolved === 0 ? "No active violations to resolve" : `${resolved} violation(s) resolved`
    });
  } catch (e) {
    logger.error(`Error resolving violations: ${e.message}`);
    return res.status(500).json({ error: `Error resolving violations: ${e.message}` });
  }
});

/**
 * Resolve a violation (release lock for that session). Admin only.
 * Body: { resolve_note?: string }
 */
router.patch("/recovery/violations/:id", verifyAdmin, async (req, res) => {
  try {
    if (!Violation) return res.status(503).json({ error: "Violations storage not available" });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid violation id" });
    const violation = await Violation.findByPk(id);
    if (!violation) return res.status(404).json({ error: "Violation not found" });
    if (violation.resolved_at) {
      return res.json({
        success: true,
        message: "Violation already resolved",
        violation_id: violation.id,
        session_id: violation.session_id
      });
    }
    const resolveNote = req.body?.resolve_note || null;
    const userId = req.user?.id ?? null;
    const resolvedAt = new Date();
    await violation.update({
      resolved_at: resolvedAt,
      resolved_by: userId,
      resolve_note: resolveNote
    });
    logger.info(`Recovery audit: violation ${violation.id} resolved by user_id=${userId}, session_id=${violation.session_id}, note=${resolveNote || '(none)'}`);
    return res.json({
      success: true,
      message: "Violation resolved; gate unlocked for session",
      violation_id: violation.id,
      session_id: violation.session_id,
      resolved_at: violation.resolved_at?.toISOString?.() || null
    });
  } catch (e) {
    logger.error(`Error resolving violation: ${e.message}`);
    return res.status(500).json({ error: `Error resolving violation: ${e.message}` });
  }
});

/**
 * Value report summary for governance: runs, successes, hard stops, violations by type, recoveries.
 * GET /admin/reports/value-summary (admin only)
 * Query: session_id, date_from, date_to (ISO), format=json|csv
 */
router.get("/reports/value-summary", verifyAdmin, async (req, res) => {
  try {
    const sessionId = req.query.session_id?.trim?.() || null;
    const dateFrom = req.query.date_from ? new Date(req.query.date_from) : null;
    const dateTo = req.query.date_to ? new Date(req.query.date_to) : null;
    const format = (req.query.format || 'json').toLowerCase();

    const runWhere = {};
    if (sessionId) runWhere.session_id = sessionId;
    if ((dateFrom && !isNaN(dateFrom.getTime())) || (dateTo && !isNaN(dateTo.getTime()))) {
      runWhere.created_at = {};
      if (dateFrom && !isNaN(dateFrom.getTime())) runWhere.created_at[Op.gte] = dateFrom;
      if (dateTo && !isNaN(dateTo.getTime())) runWhere.created_at[Op.lte] = dateTo;
    }

    const totalRuns = ResearchLoopRun
      ? await ResearchLoopRun.count({ where: runWhere }).catch(() => 0)
      : 0;
    const stoppedByViolation = ResearchLoopRun
      ? await ResearchLoopRun.count({ where: { ...runWhere, stopped_by_violation: true } }).catch(() => 0)
      : 0;
    const successfulRuns = totalRuns - stoppedByViolation;

    const violationWhere = {};
    if (sessionId) violationWhere.session_id = sessionId;
    if ((dateFrom && !isNaN(dateFrom.getTime())) || (dateTo && !isNaN(dateTo.getTime()))) {
      violationWhere.created_at = {};
      if (dateFrom && !isNaN(dateFrom.getTime())) violationWhere.created_at[Op.gte] = dateFrom;
      if (dateTo && !isNaN(dateTo.getTime())) violationWhere.created_at[Op.lte] = dateTo;
    }
    const violations = Violation
      ? await Violation.findAll({
          where: Object.keys(violationWhere).length ? violationWhere : {},
          attributes: ['id', 'session_id', 'reason', 'details', 'resolved_at', 'resolved_by', 'resolve_note', 'created_at'],
          raw: true
        }).catch(() => [])
      : [];
    const byReason = {};
    let resolvedCount = 0;
    for (const v of violations) {
      const r = (v.reason || 'B_INTEGRITY');
      byReason[r] = (byReason[r] || 0) + 1;
      if (v.resolved_at) resolvedCount += 1;
    }

    let durationStats = null;
    if (ResearchLoopRun) {
      const withDuration = await ResearchLoopRun.findAll({
        attributes: ['duration_ms'],
        where: { ...runWhere, duration_ms: { [Op.ne]: null } },
        raw: true
      }).catch(() => []);
      const values = withDuration.map(r => r.duration_ms).filter(n => typeof n === 'number');
      if (values.length > 0) {
        durationStats = {
          avg_ms: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
          min_ms: Math.min(...values),
          max_ms: Math.max(...values),
          count: values.length
        };
      }
    }

    const payload = {
      runs: { total: totalRuns, successful: successfulRuns, stopped_by_violation: stoppedByViolation },
      violations_by_reason: byReason,
      recoveries: { total_resolved: resolvedCount },
      duration_ms: durationStats,
      violations: violations.map(v => ({
        id: v.id,
        session_id: v.session_id,
        reason: v.reason,
        details: v.details,
        created_at: v.created_at,
        resolved_at: v.resolved_at,
        resolved_by: v.resolved_by,
        resolve_note: v.resolve_note
      }))
    };

    if (format === 'csv') {
      const rows = [
        ['metric', 'value'],
        ['total_runs', payload.runs.total],
        ['successful_runs', payload.runs.successful],
        ['stopped_by_violation', payload.runs.stopped_by_violation],
        ['recoveries_total_resolved', payload.recoveries.total_resolved],
        ...(payload.duration_ms ? [['duration_avg_ms', payload.duration_ms.avg_ms], ['duration_min_ms', payload.duration_ms.min_ms], ['duration_max_ms', payload.duration_ms.max_ms]] : [])
      ];
      const csv = rows.map(r => r.join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=value-summary.csv');
      return res.send('\uFEFF' + csv);
    }

    return res.json(payload);
  } catch (e) {
    logger.error(`Error building value summary: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

export { router as adminRouter };
