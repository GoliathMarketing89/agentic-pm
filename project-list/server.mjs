import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateProjects, validateOrganization, islandPath, InputError, ConflictError } from './lib/projects.ts';
import { moveOrganization, removeProject, restoreProject } from './public/moves.mjs';
import { archiveProject, restoreArchivedProject } from './public/archive-state.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/moves.mjs': ['moves.mjs', 'text/javascript'], '/archive-state.mjs': ['archive-state.mjs', 'text/javascript'], '/board-view.mjs': ['board-view.mjs', 'text/javascript'], '/board-view.css': ['board-view.css', 'text/css'], '/view-preferences.mjs': ['view-preferences.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
assets['/board-alignment.mjs'] = ['board-alignment.mjs', 'text/javascript'];
assets['/agent-skills.zip'] = ['agent-skills.zip', 'application/zip'];
assets['/agent-skills-guide.md'] = ['../agent-skills/README.md', 'text/markdown'];

export function createApp({ dataDir = join(root, 'data'), agentName = 'Codex', now = () => new Date() } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'projects.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT);
    INSERT OR IGNORE INTO state VALUES (1, 0, '[]', NULL);
    CREATE TABLE IF NOT EXISTS changes (revision INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, previous_data TEXT NOT NULL, changed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS change_actors (revision INTEGER PRIMARY KEY, actor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_operations (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS organization (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trash (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pins (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS undo_journal (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL, field TEXT, old_value TEXT, new_value TEXT, event_time TEXT NOT NULL, actor TEXT NOT NULL, command_id TEXT);
    CREATE INDEX IF NOT EXISTS project_history_project_id_id ON project_history(project_id, id DESC);
    CREATE TABLE IF NOT EXISTS command_results (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_revision INTEGER NOT NULL, command_id TEXT);
    INSERT OR IGNORE INTO trash VALUES (1, '[]');
    INSERT OR IGNORE INTO pins VALUES (1, '[]');
    INSERT OR IGNORE INTO organization VALUES (1, '{"groups":[],"assignments":{}}');`);
  db.prepare("INSERT OR IGNORE INTO undo_journal VALUES (1, '[]')").run();
  const clockNow = () => now().toISOString();
  const journal = () => JSON.parse(db.prepare('SELECT data FROM undo_journal WHERE id=1').get().data);
  const writeJournal = entries => db.prepare('UPDATE undo_journal SET data=? WHERE id=1').run(JSON.stringify(entries));
  function pruneNoopReceipts() {
    const stale = `SELECT request_id FROM command_results WHERE command_id IS NULL AND rowid NOT IN (SELECT rowid FROM command_results WHERE command_id IS NULL ORDER BY rowid DESC LIMIT 500)`;
    db.exec(`DELETE FROM agent_operations WHERE request_id IN (${stale}); DELETE FROM command_results WHERE request_id IN (${stale});`);
  }
  function recordNoopReceipt(requestId, fingerprint, revision, agentOperation = false) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (Number(db.prepare('SELECT revision FROM state WHERE id=1').get().revision) !== revision) throw new ConflictError('The workspace changed. Read again before retrying.');
      const existing = db.prepare('SELECT fingerprint FROM command_results WHERE request_id=?').get(requestId);
      if (existing && existing.fingerprint !== fingerprint) throw new InputError('This requestId was already used for different arguments.');
      db.prepare('INSERT OR IGNORE INTO command_results(request_id,fingerprint,result_revision,command_id) VALUES(?,?,?,NULL)').run(requestId, fingerprint, revision);
      if (agentOperation) db.prepare('INSERT OR IGNORE INTO agent_operations(request_id,fingerprint,revision) VALUES(?,?,?)').run(requestId, fingerprint, revision);
      pruneNoopReceipts();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const session = randomBytes(32).toString('hex');
  let closed = false;
  const snapshot = () => {
    const row = db.prepare('SELECT state.*, (SELECT data FROM organization WHERE id=1) AS organization_data FROM state WHERE id=1').get();
    const projects = JSON.parse(row.data);
    const trash = JSON.parse(db.prepare('SELECT data FROM trash WHERE id=1').get().data).filter(entry => Date.parse(entry.deletedAt) > now().getTime() - 7 * 86400000);
    const pins = JSON.parse(db.prepare('SELECT data FROM pins WHERE id=1').get().data);
    const knownIds = new Set([...projects.map(project => project.id), ...trash.map(entry => entry.project.id)]);
    if (!Array.isArray(pins) || pins.length > 300 || pins.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) || new Set(pins).size !== pins.length) throw new InputError('Invalid pinned projects.');
    // Old databases or a project whose seven-day deletion window elapsed may leave
    // an orphaned preference. Hide it safely; never bring the deleted entry back.
    const undo = journal();
    const latest = undo.at(-1);
    let undoInfo = null;
    if (latest) {
      const blockedReason = undoBlockedReason(latest);
      undoInfo = { commandId: latest.commandId, label: latest.label, actor: latest.actor, remaining: undo.length, ...(blockedReason ? { blockedReason } : {}) };
    }
    return { revision: Number(row.revision), projects, organization: validateOrganization(JSON.parse(row.organization_data), projects, trash.map(entry => entry.project.id)), trash, pins: pins.filter(id => knownIds.has(id)), updatedAt: row.updated_at, undo: undoInfo };
  };
  function undoBlockedReason(command) {
    const cutoff = now().getTime() - 7 * 86400000;
    const deleted = command.after.trash.find(entry => !command.before.trash.some(prev => prev.project.id === entry.project.id));
    if (deleted && Date.parse(deleted.deletedAt) <= cutoff) return 'The seven-day recovery period has expired; this deletion cannot be undone.';
    const restored = command.before.trash.find(entry => Date.parse(entry.deletedAt) <= cutoff && command.after.projects.some(project => project.id === entry.project.id) && !command.before.projects.some(project => project.id === entry.project.id));
    if (restored) return "The deleted project's original seven-day recovery period has expired; this restoration cannot be undone.";
    return null;
  }
  function safetyBackup() {
    const target = join(backupDir, `before-import-${now().getTime()}-${randomBytes(3).toString('hex')}.sqlite`);
    db.prepare('VACUUM INTO ?').run(target);
    const files = readdirSync(backupDir).filter(name => /^before-import-\d+-[a-f0-9]+\.sqlite$/.test(name)).sort();
    for (const file of files.slice(0, -10)) unlinkSync(join(backupDir, file));
  }
  function dailyBackup() {
    const day = now().toISOString().slice(0, 10);
    const target = join(backupDir, `projects-${day}.sqlite`);
    if (!existsSync(target)) {
      try { db.prepare('VACUUM INTO ?').run(target); }
      catch (error) { if (!existsSync(target)) throw error; }
    }
    const files = readdirSync(backupDir).filter(name => /^projects-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort();
    for (const file of files.slice(0, -7)) unlinkSync(join(backupDir, file));
  }
  function save(body, actor = 'User') {
    if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.requestId)) throw new InputError('Invalid save request. Refresh and try again.');
    const projects = validateProjects(body.projects);
    const previous = snapshot();
    const rawTrash = body.trash ?? (body.restore === true ? [] : previous.trash);
    if (!Array.isArray(rawTrash) || rawTrash.length > 300) throw new InputError('Keep Recently deleted to 300 projects or fewer.');
    const trashIds = new Set(projects.map(project => project.id));
    const trash = rawTrash.map(entry => {
      if (!entry || typeof entry !== 'object' || typeof entry.deletedAt !== 'string' || !Number.isFinite(Date.parse(entry.deletedAt)) || Date.parse(entry.deletedAt) > now().getTime() + 60000) throw new InputError('Invalid deleted project date.');
      const project = validateProjects([entry.project])[0];
      if (trashIds.has(project.id)) throw new InputError('A project cannot be both active and deleted or appear twice in Recently deleted.');
      trashIds.add(project.id);
      for (const key of ['parentProjectId', 'groupId']) if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry[key]))) throw new InputError('Invalid deleted project placement.');
      return { project, deletedAt: entry.deletedAt, ...(entry.parentProjectId ? { parentProjectId: entry.parentProjectId } : {}), ...(entry.groupId ? { groupId: entry.groupId } : {}) };
    }).filter(entry => Date.parse(entry.deletedAt) > now().getTime() - 7 * 86400000);
    const organization = validateOrganization(body.organization ?? (body.restore === true ? undefined : previous.organization), projects, trash.map(entry => entry.project.id));
    const rawPins = body.pins ?? (body.restore === true ? [] : previous.pins);
    if (!Array.isArray(rawPins) || rawPins.length > 300 || rawPins.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) || new Set(rawPins).size !== rawPins.length) throw new InputError('Pinned projects must be a unique list of project ids.');
    const knownPinIds = new Set([...projects.map(project => project.id), ...trash.map(entry => entry.project.id)]);
    if (rawPins.some(id => !knownPinIds.has(id))) throw new InputError('A pin must refer to an active or recently deleted project.');
    const pins = rawPins;
    const fingerprint = body.operationFingerprint ?? createHash('sha256').update(JSON.stringify({ projects, organization, trash, pins, projectHistory: body.restore === true ? body.projectHistory ?? null : null })).digest('hex');
    const priorResult = db.prepare('SELECT fingerprint FROM command_results WHERE request_id=?').get(body.requestId);
    if (priorResult) {
      if (priorResult.fingerprint !== fingerprint) throw new InputError('This requestId was already used for different arguments. Use a new requestId.');
      return previous;
    }
    if (previous.revision !== body.revision) return null;
    const before = { projects: previous.projects, organization: previous.organization, trash: previous.trash, pins: previous.pins };
    const after = { projects, organization, trash, pins };
    const changed = JSON.stringify(before) !== JSON.stringify(after) || body.restore === true;
    if (!changed) {
      recordNoopReceipt(body.requestId, fingerprint, previous.revision, Boolean(body.operationFingerprint));
      return snapshot();
    }
    if (body.restore === true) safetyBackup();
    dailyBackup();
    const changedAt = clockNow();
    const commandId = randomBytes(18).toString('base64url');
    const label = commandLabel(before, after);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('UPDATE state SET revision=revision+1, data=?, updated_at=? WHERE id=1 AND revision=?').run(JSON.stringify(projects), changedAt, body.revision);
      if (!result.changes) { db.exec('ROLLBACK'); return null; }
      db.prepare('UPDATE organization SET data=? WHERE id=1').run(JSON.stringify(organization));
      db.prepare('UPDATE trash SET data=? WHERE id=1').run(JSON.stringify(trash));
      db.prepare('UPDATE pins SET data=? WHERE id=1').run(JSON.stringify(pins));
      db.prepare('INSERT INTO changes (revision, request_id, previous_data, changed_at) VALUES (?, ?, ?, ?)').run(body.revision + 1, body.requestId, JSON.stringify(before), changedAt);
      db.prepare('INSERT INTO change_actors (revision, actor) VALUES (?, ?)').run(body.revision + 1, actor);
      if (body.operationFingerprint) db.prepare('INSERT INTO agent_operations (request_id, fingerprint, revision) VALUES (?, ?, ?)').run(body.requestId, body.operationFingerprint, body.revision + 1);
      const undo = body.restore === true ? [] : journal();
      undo.push({ commandId, requestId: body.requestId, fingerprint, revision: body.revision + 1, label, actor, time: changedAt, before, after, ...(body.restore === true ? { beforeHistory: db.prepare('SELECT * FROM project_history ORDER BY id').all() } : {}) });
      writeJournal(undo.slice(-10));
      db.prepare('INSERT INTO command_results(request_id,fingerprint,result_revision,command_id) VALUES(?,?,?,?)').run(body.requestId, fingerprint, body.revision + 1, commandId);
      if (body.restore === true && body.projectHistory !== undefined) {
        if (!Array.isArray(body.projectHistory) || body.projectHistory.length > 100000) throw new InputError('Invalid imported project history.');
        db.prepare('DELETE FROM project_history').run();
        const insertHistory = db.prepare('INSERT INTO project_history(project_id,kind,field,old_value,new_value,event_time,actor,command_id) VALUES(?,?,?,?,?,?,?,?)');
        for (const event of body.projectHistory) {
          if (!event || typeof event !== 'object' || !/^[a-zA-Z0-9_-]{1,100}$/.test(event.projectId) || !['update','create','delete','remove','archive','restore','undo'].includes(event.kind) || !Number.isFinite(Date.parse(event.time)) || typeof event.actor !== 'string' || event.actor.length > 160 || (event.field !== undefined && !['currentTask','notes'].includes(event.field)) || (event.oldValue !== undefined && (typeof event.oldValue !== 'string' || event.oldValue.length > 10000)) || (event.newValue !== undefined && (typeof event.newValue !== 'string' || event.newValue.length > 10000))) throw new InputError('Invalid imported project history event.');
          insertHistory.run(event.projectId, event.kind, event.field ?? null, event.oldValue ?? null, event.newValue ?? null, event.time, event.actor, null);
        }
      }
      recordProjectHistory(before, after, actor, changedAt, commandId, false);
      db.prepare('DELETE FROM command_results WHERE result_revision <= ?').run(body.revision - 49);
      db.prepare('DELETE FROM agent_operations WHERE revision <= ?').run(body.revision - 49);
      db.prepare('DELETE FROM changes WHERE revision <= ?').run(body.revision - 49);
      db.prepare('DELETE FROM change_actors WHERE revision <= ?').run(body.revision - 49);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return snapshot();
  }
  function commandLabel(before, after) {
    const b = new Map(before.projects.map(p => [p.id, p])); const a = new Map(after.projects.map(p => [p.id, p]));
    const created = [...a.keys()].filter(id => !b.has(id)); if (created.length) return `Create ${a.get(created[0]).name}`;
    const deleted = [...b.keys()].filter(id => !a.has(id)); if (deleted.length) return `Delete ${b.get(deleted[0]).name}`;
    const pinChange = JSON.stringify(before.pins) !== JSON.stringify(after.pins); if (pinChange) return 'Change pinned projects';
    const board = JSON.stringify(before.organization.boardPositions || {}) !== JSON.stringify(after.organization.boardPositions || {}); if (board) return 'Move island';
    for (const [id, p] of a) if (b.has(id) && p.name !== b.get(id).name) return `Rename ${p.name}`;
    if (JSON.stringify(before.organization) !== JSON.stringify(after.organization)) return 'Change project organization';
    if (JSON.stringify(before.trash) !== JSON.stringify(after.trash)) return 'Delete or restore project';
    return 'Update project';
  }
  function recordProjectHistory(before, after, actor, time, commandId, isUndo) {
    const oldMap = new Map(before.projects.map(p => [p.id, p])); const newMap = new Map(after.projects.map(p => [p.id, p]));
    const insert = db.prepare('INSERT INTO project_history(project_id,kind,field,old_value,new_value,event_time,actor,command_id) VALUES(?,?,?,?,?,?,?,?)');
    for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) {
      const oldProject = oldMap.get(id), newProject = newMap.get(id);
      if (!oldProject || !newProject) {
        const wasDeleted = (before.trash || []).some(entry => entry.project.id === id);
        const isDeleted = (after.trash || []).some(entry => entry.project.id === id);
        const kind = isUndo ? 'undo' : (oldProject ? (isDeleted ? 'delete' : 'remove') : (wasDeleted ? 'restore' : 'create'));
        insert.run(id, kind, null, oldProject?.name ?? null, newProject?.name ?? null, time, actor, commandId);
        continue;
      }
      for (const field of ['currentTask', 'notes']) if (oldProject[field] !== newProject[field]) insert.run(id, isUndo ? 'undo' : 'update', field, oldProject[field] ?? '', newProject[field] ?? '', time, actor, commandId);
      const wasArchived = Boolean(before.organization.archives?.[id]); const isArchived = Boolean(after.organization.archives?.[id]);
      if (wasArchived !== isArchived) insert.run(id, isUndo ? 'undo' : (isArchived ? 'archive' : 'restore'), null, String(wasArchived), String(isArchived), time, actor, commandId);
    }
  }
  function readProjectHistory({ projectId, limit = 50, beforeId } = {}) {
    if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(projectId)) throw new InputError('Provide an exact projectId.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InputError('History limit must be from 1 to 100.');
    if (beforeId !== undefined && (!Number.isSafeInteger(Number(beforeId)) || Number(beforeId) < 1)) throw new InputError('Invalid history cursor.');
    const rows = db.prepare(`SELECT id, project_id, kind, field, old_value, new_value, event_time, actor, command_id FROM project_history WHERE project_id=? ${beforeId === undefined ? '' : 'AND id<?'} ORDER BY id DESC LIMIT ?`).all(...(beforeId === undefined ? [projectId, limit + 1] : [projectId, Number(beforeId), limit + 1]));
    const more = rows.length > limit;
    const events = rows.slice(0, limit).map(row => ({ id: String(row.id), projectId: row.project_id, kind: row.kind, ...(row.field ? { field: row.field } : {}), ...(row.old_value !== null ? { oldValue: row.old_value } : {}), ...(row.new_value !== null ? { newValue: row.new_value } : {}), time: row.event_time, actor: row.actor, ...(row.command_id ? { commandId: row.command_id } : {}) }));
    return { events, ...(more ? { nextCursor: events.at(-1).id } : {}) };
  }
  function undoLastChange(args, actor = 'User') {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['commandId', 'expectedRevision', 'requestId'].includes(key)) || typeof args.commandId !== 'string' || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || typeof args.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw new InputError('Provide the exact commandId, expectedRevision and a unique requestId.');
    const requestId = createHash('sha256').update(`undo:${args.requestId}`).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const oldResult = db.prepare('SELECT fingerprint FROM command_results WHERE request_id=?').get(requestId);
    if (oldResult) { if (oldResult.fingerprint !== fingerprint) throw new InputError('This undo requestId was already used with different arguments.'); return snapshot(); }
    const current = snapshot();
    if (current.revision !== args.expectedRevision) throw new ConflictError('The workspace changed. Read the latest snapshot before undoing.');
    const entries = journal(), top = entries.at(-1);
    if (!top || top.commandId !== args.commandId) throw new ConflictError('That action is no longer the latest undoable change.');
    const blockedReason = undoBlockedReason(top);
    if (blockedReason) throw new InputError(blockedReason);
    // An exact current revision means the snapshot inverse cannot erase an intervening write.
    const target = top.before;
    const undoTime = clockNow();
    const undoRequestId = requestId;
    const undoCommandId = randomBytes(18).toString('base64url');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('UPDATE state SET revision=revision+1,data=?,updated_at=? WHERE id=1 AND revision=?').run(JSON.stringify(target.projects), undoTime, args.expectedRevision);
      if (!result.changes) { db.exec('ROLLBACK'); throw new ConflictError('The workspace changed. Read the latest snapshot before undoing.'); }
      db.prepare('UPDATE organization SET data=? WHERE id=1').run(JSON.stringify(target.organization));
      const stillValidTrash = target.trash.filter(entry => Date.parse(entry.deletedAt) > now().getTime() - 7 * 86400000);
      db.prepare('UPDATE trash SET data=? WHERE id=1').run(JSON.stringify(stillValidTrash));
      const activeIds = new Set(target.projects.map(project => project.id));
      const validPins = target.pins.filter(id => activeIds.has(id) || stillValidTrash.some(entry => entry.project.id === id));
      db.prepare('UPDATE pins SET data=? WHERE id=1').run(JSON.stringify(validPins));
      db.prepare('INSERT INTO changes(revision,request_id,previous_data,changed_at) VALUES(?,?,?,?)').run(args.expectedRevision + 1, undoRequestId, JSON.stringify({ projects: current.projects, organization: current.organization, trash: current.trash, pins: current.pins }), undoTime);
      db.prepare('INSERT INTO change_actors(revision,actor) VALUES(?,?)').run(args.expectedRevision + 1, actor);
      entries.pop(); writeJournal(entries);
      if (Array.isArray(top.beforeHistory)) {
        db.prepare('DELETE FROM project_history').run();
        const restoreHistory = db.prepare('INSERT INTO project_history(id,project_id,kind,field,old_value,new_value,event_time,actor,command_id) VALUES(?,?,?,?,?,?,?,?,?)');
        for (const event of top.beforeHistory) restoreHistory.run(event.id,event.project_id,event.kind,event.field,event.old_value,event.new_value,event.event_time,event.actor,event.command_id);
      }
      db.prepare('INSERT INTO command_results(request_id,fingerprint,result_revision,command_id) VALUES(?,?,?,?)').run(undoRequestId, fingerprint, args.expectedRevision + 1, undoCommandId);
      db.prepare('DELETE FROM command_results WHERE result_revision <= ?').run(args.expectedRevision - 49);
      recordProjectHistory({ projects: current.projects, organization: current.organization, trash: current.trash }, { projects: target.projects, organization: target.organization, trash: stillValidTrash }, actor, undoTime, top.commandId, true);
      if (Array.isArray(top.beforeHistory)) {
        const insertContext = db.prepare('INSERT INTO project_history(project_id,kind,old_value,new_value,event_time,actor,command_id) VALUES(?,?,?,?,?,?,?)');
        for (const project of target.projects) if (!db.prepare("SELECT 1 FROM project_history WHERE project_id=? AND command_id=? AND kind='undo'").get(project.id,top.commandId)) insertContext.run(project.id,'undo','Imported project history','Previous project history',undoTime,actor,top.commandId);
      }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return snapshot();
  }
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 4173;
    const origin = `http://127.0.0.1:${port}`;
    const common = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    };
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...common, 'Content-Type': 'application/json; charset=utf-8', ...headers });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Open the app at its 127.0.0.1 address.' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { app: 'agentic-pm', version: 2 });
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        const headers = { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type };
        if (url.pathname === '/') headers['Set-Cookie'] = `project_session=${session}; HttpOnly; SameSite=Strict; Path=/`;
        return send(200, readFileSync(join(root, 'public', file)), headers);
      }
      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found.' });
      const cookies = (req.headers.cookie || '').split(';').map(part => part.trim());
      if (!cookies.includes(`project_session=${session}`)) return send(401, { error: 'Reload the page to reconnect to the local app.' });
      if (req.method === 'GET' && url.pathname === '/api/projects') return send(200, snapshot());
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const hist = db.prepare('SELECT id,project_id,kind,field,old_value,new_value,event_time,actor FROM project_history ORDER BY id ASC').all().map(row => ({ id: String(row.id), projectId: row.project_id, kind: row.kind, ...(row.field ? { field: row.field } : {}), ...(row.old_value !== null ? { oldValue: row.old_value } : {}), ...(row.new_value !== null ? { newValue: row.new_value } : {}), time: row.event_time, actor: row.actor }));
        return send(200, { schemaVersion: 6, exportedAt: now().toISOString(), ...snapshot(), projectHistory: hist, undoJournal: { commands: journal().map(({ commandId, label, actor, time }) => ({ commandId, label, actor, time })) } }, { 'Content-Disposition': `attachment; filename="projects-${now().toISOString().slice(0, 10)}.json"` });
      }
      if (req.method === 'GET' && url.pathname === '/api/history') return send(200, readProjectHistory({ projectId: url.searchParams.get('projectId'), limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50, beforeId: url.searchParams.get('beforeId') ?? undefined }));
      if (req.method === 'POST' && url.pathname === '/api/undo') {
        if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Only this local page can undo changes.' });
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 100_000) return send(413, { error: 'Undo request is too large.' }); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'Invalid JSON.' }); }
        return send(200, undoLastChange(body));
      }
      if (req.method !== 'PUT' || url.pathname !== '/api/projects') return send(405, { error: 'Method not allowed.' });
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Only this local page can save changes.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use JSON for saves.' });
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 100_000_000) return send(413, { error: 'This backup exceeds the 100 MB import limit.' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'Invalid JSON.' }); }
      const saved = save(body);
      if (!saved) return send(409, { error: 'The list changed in another window. Your draft is still here; reload the latest list before saving again.', current: snapshot() });
      return send(200, saved);
    } catch (error) {
      if (error instanceof InputError) return send(400, { error: error.message });
      if (error instanceof ConflictError) return send(409, { error: error.message, current: snapshot() });
      console.error('Local project storage error:', error.message);
      return send(500, { error: 'Could not access local storage. Your changes have not been confirmed; keep this window open and try again.' });
    }
  });
  function updateProject(args) {
    const allowed = new Set(['projectId', 'expectedRevision', 'requestId', 'currentTask', 'notes', 'needsMichael']);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.has(key))) throw new InputError('Agents may only update currentTask, notes and needsMichael. Names and links belong to User.');
    if (typeof args.projectId !== 'string' || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || typeof args.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw new InputError('Provide a projectId, the expectedRevision from a fresh read, and a unique requestId.');
    const fields = ['currentTask', 'notes', 'needsMichael'].filter(key => Object.hasOwn(args, key));
    if (!fields.length) throw new InputError('Provide at least one field to update.');
    const current = snapshot();
    const index = current.projects.findIndex(project => project.id === args.projectId);
    if (index === -1) throw new InputError('Project not found. Read the list and use its exact project id; agents cannot create projects.');
    const next = current.projects.map((project, position) => position === index ? { ...project, ...Object.fromEntries(fields.map(key => [key, args[key]])) } : project);
    const requestId = createHash('sha256').update(`${agentName}:${args.requestId}`).digest('hex');
    const saved = save({ revision: args.expectedRevision, requestId, projects: next }, `agent:${agentName}`);
    if (!saved) throw new ConflictError('The list changed. Read the project again, preserve newer human changes, and submit a new requestId with the latest revision.');
    return { revision: saved.revision, project: saved.projects.find(project => project.id === args.projectId), pinned: saved.pins.includes(args.projectId), islandPath: islandPath(saved.organization, args.projectId), updatedAt: saved.updatedAt };
  }
  function createProject(args) {
    const allowed = new Set(['name', 'currentTask', 'notes', 'needsMichael', 'groupId', 'expectedRevision', 'requestId']);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.has(key))) throw new InputError('Provide only new project fields, an optional existing groupId, expectedRevision and requestId.');
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || typeof args.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw new InputError('Read the list first and provide expectedRevision and a unique requestId.');
    const current = snapshot();
    const requestId = createHash('sha256').update(`${agentName}:create:${args.requestId}`).digest('hex');
    const id = `project-${requestId}`;
    const existing = current.projects.find(project => project.id === id);
    if (existing) return { revision: current.revision, project: existing, pinned: current.pins.includes(id), islandPath: islandPath(current.organization, id), updatedAt: current.updatedAt };
    if (args.groupId !== undefined && (typeof args.groupId !== 'string' || !current.organization.groups.some(group => group.id === args.groupId))) throw new InputError('Use an existing group id from list_projects.');
    const project = { id, name: args.name, currentTask: args.currentTask ?? '', notes: args.notes ?? '', needsMichael: args.needsMichael ?? false, links: [] };
    const organization = { ...current.organization, assignments: { ...current.organization.assignments, ...(args.groupId ? { [id]: args.groupId } : {}) } };
    const saved = save({ revision: args.expectedRevision, requestId, projects: [...current.projects, project], organization }, `agent:${agentName}`);
    if (!saved) throw new ConflictError('The list changed. Read again and use a new requestId with the latest revision.');
    return { revision: saved.revision, project: saved.projects.find(project => project.id === id), pinned: saved.pins.includes(id), islandPath: islandPath(saved.organization, id), updatedAt: saved.updatedAt };
  }
  function projectOperation(kind, args) {
    if (kind === 'clear-pins') return pinOperation(kind, args);
    if (kind === 'pin' || kind === 'unpin') return pinOperation(kind, args);
    const allowed = new Set(['projectId', 'expectedRevision', 'requestId', ...(kind === 'move' ? ['parentProjectId', 'groupId'] : [])]);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.has(key))) throw new InputError('Provide only the project id, revision, request id and permitted destination fields.');
    if (typeof args.projectId !== 'string' || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || typeof args.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw new InputError('Read the list first and provide projectId, expectedRevision and a unique requestId.');
    if (kind === 'move') {
      if (Object.hasOwn(args, 'parentProjectId') === Object.hasOwn(args, 'groupId')) throw new InputError('Choose exactly one destination: parentProjectId, or groupId (null for Unsorted).');
      if (Object.hasOwn(args, 'parentProjectId') && typeof args.parentProjectId !== 'string') throw new InputError('Use an exact parent project id. To unnest, choose a groupId or null.');
      if (Object.hasOwn(args, 'groupId') && args.groupId !== null && typeof args.groupId !== 'string') throw new InputError('Use an exact groupId or null for Unsorted.');
    }
    const requestId = createHash('sha256').update(`${agentName}:${kind}:${args.requestId}`).digest('hex');
    const operationFingerprint = JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
    const completed = db.prepare('SELECT fingerprint FROM agent_operations WHERE request_id=?').get(requestId);
    if (completed) {
      if (completed.fingerprint !== operationFingerprint) throw new InputError('This requestId was already used for different arguments. Use a new requestId.');
      return snapshot();
    }
    const current = snapshot();
    if (current.revision !== args.expectedRevision) throw new ConflictError('The list changed. Read again and use a new requestId with the latest revision.');
    let next;
    try {
      if (kind === 'move') next = { ...current, organization: moveOrganization(current, { kind: 'project', id: args.projectId }, Object.hasOwn(args, 'parentProjectId') ? { kind: 'project', id: args.parentProjectId } : args.groupId) };
      else if (kind === 'delete') next = removeProject(current, args.projectId);
      else if (kind === 'restore') next = restoreProject(current, args.projectId);
      else if (kind === 'archive') next = { ...current, ...archiveProject(current, args.projectId, new Date().toISOString(), `batch-${requestId}`) };
      else next = { ...current, ...restoreArchivedProject(current, args.projectId) };
    } catch (error) { throw new InputError(error.message); }
    const saved = save({ revision: args.expectedRevision, requestId, projects: next.projects, organization: next.organization, trash: next.trash, operationFingerprint }, `agent:${agentName}`);
    if (!saved) throw new ConflictError('The list changed. Read again and use a new requestId with the latest revision.');
    return saved;
  }
  function pinOperation(kind, args) {
    const allowed = new Set(['projectId', 'expectedRevision', 'requestId']);
    if (kind === 'clear-pins') allowed.delete('projectId');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.has(key))) throw new InputError('Provide only the project id, revision and request id for pin changes.');
    if ((kind !== 'clear-pins' && typeof args.projectId !== 'string') || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || typeof args.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw new InputError('Read the list first and provide the required projectId, expectedRevision and unique requestId.');
    const requestId = createHash('sha256').update(`${agentName}:${kind}:${args.requestId}`).digest('hex');
    const operationFingerprint = JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
    const completed = db.prepare('SELECT fingerprint FROM agent_operations WHERE request_id=?').get(requestId);
    if (completed) {
      if (completed.fingerprint !== operationFingerprint) throw new InputError('This requestId was already used for different arguments. Use a new requestId.');
      return snapshot();
    }
    const current = snapshot();
    if (current.revision !== args.expectedRevision) throw new ConflictError('The list changed. Read again and use a new requestId with the latest revision.');
    let pins;
    if (kind === 'clear-pins') pins = [];
    else {
      if (!current.projects.some(project => project.id === args.projectId)) throw new InputError('Only an active project can be pinned. Read the list and use its exact project id.');
      pins = kind === 'pin' ? [...new Set([...current.pins, args.projectId])] : current.pins.filter(id => id !== args.projectId);
    }
    if (JSON.stringify(pins) === JSON.stringify(current.pins)) {
      recordNoopReceipt(requestId, operationFingerprint, current.revision, true);
      return snapshot();
    }
    const saved = save({ revision: args.expectedRevision, requestId, projects: current.projects, organization: current.organization, trash: current.trash, pins, operationFingerprint }, `agent:${agentName}`);
    if (!saved) throw new ConflictError('The list changed. Read again and use a new requestId with the latest revision.');
    return saved;
  }
  function setIslandPosition(args) {
    const allowed = new Set(['islandId', 'x', 'y', 'expectedRevision', 'requestId']);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.has(key)) || typeof args.islandId !== 'string' || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || typeof args.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw new InputError('Provide an islandId, finite x/y coordinates, expectedRevision and a unique requestId.');
    const requestId = createHash('sha256').update(`${agentName}:set-island-position:${args.requestId}`).digest('hex');
    const operationFingerprint = JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
    const completed = db.prepare('SELECT fingerprint FROM agent_operations WHERE request_id=?').get(requestId);
    if (completed) {
      if (completed.fingerprint !== operationFingerprint) throw new InputError('This requestId was already used for different arguments. Use a new requestId.');
      return snapshot();
    }
    const current = snapshot();
    if (current.revision !== args.expectedRevision) throw new ConflictError('The list changed. Read again and use a new requestId with the latest revision.');
    const key = args.islandId;
    if (key !== '__unsorted__' && !current.organization.groups.some(group => group.id === key)) throw new InputError('Use an exact existing island id or __unsorted__.');
    const boardPositions = { ...(current.organization.boardPositions || {}), [key]: { x: args.x, y: args.y } };
    const saved = save({ revision: args.expectedRevision, requestId, projects: current.projects, organization: { ...current.organization, boardPositions }, operationFingerprint }, `agent:${agentName}`);
    if (!saved) throw new ConflictError('The list changed. Read again and use a new requestId with the latest revision.');
    return saved;
  }
  async function agentAction(kind, args) {
    const supported = new Set(['update-project', 'create-project', 'reorder-project', 'create-island', 'update-island', 'remove-island']);
    const envelope = new Set(['expectedRevision', 'requestId']);
    if (!supported.has(kind) || !args || typeof args !== 'object' || Array.isArray(args) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || typeof args.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw new InputError('Read the workspace and provide expectedRevision and a unique requestId.');
    const payload = Object.fromEntries(Object.entries(args).filter(([key]) => !envelope.has(key)));
    const operationFingerprint = JSON.stringify({ kind, args: Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)) });
    const requestId = createHash('sha256').update(`${agentName}:${kind}:${args.requestId}`).digest('hex');
    const completed = db.prepare('SELECT fingerprint FROM command_results WHERE request_id=?').get(requestId);
    if (completed) { if (completed.fingerprint !== operationFingerprint) throw new InputError('This requestId was already used for different arguments. Use a new requestId.'); return snapshot(); }
    if (args.expectedRevision !== snapshot().revision) throw new ConflictError('The workspace changed. Read again and use a new requestId with the latest revision.');
    const semanticArgs = { ...payload };
    if (kind === 'create-project' || kind === 'create-island') {
      const idField = kind === 'create-project' ? 'id' : 'id';
      if (!Object.hasOwn(semanticArgs, idField)) semanticArgs[idField] = `${kind === 'create-project' ? 'project' : 'island'}-${createHash('sha256').update(`${agentName}:${args.requestId}`).digest('hex').slice(0, 24)}`;
    }
    const { buildAgentChange } = await import('./lib/agent-actions.mjs');
    const current = snapshot();
    let change;
    try { change = buildAgentChange(current, kind, semanticArgs); } catch (error) { throw new InputError(error.message); }
    const saved = save({ revision: args.expectedRevision, requestId, projects: change.projects, organization: change.organization, pins: change.pins, trash: change.trash, operationFingerprint }, `agent:${agentName}`);
    if (!saved) throw new ConflictError('The workspace changed. Read again and use a new requestId with the latest revision.');
    const output = { ...saved };
    const projectId = kind === 'create-project' ? semanticArgs.id : payload.projectId;
    const islandId = ['create-island', 'update-island'].includes(kind) ? (semanticArgs.id ?? payload.islandId) : null;
    if (projectId) output.project = saved.projects.find(project => project.id === projectId);
    if (islandId) output.island = saved.organization.groups.find(group => group.id === islandId);
    return output;
  }
  return { server, readProjects: snapshot, readProjectHistory, undoLastChange, agentAction, updateProject, createProject, moveProject: args => projectOperation('move', args), deleteProject: args => projectOperation('delete', args), restoreProject: args => projectOperation('restore', args), archiveProject: args => projectOperation('archive', args), restoreArchivedProject: args => projectOperation('restore-archive', args), setIslandPosition, pinProject: args => pinOperation('pin', args), unpinProject: args => pinOperation('unpin', args), clearPins: args => pinOperation('clear-pins', args), close: async () => { if (closed) return; closed = true; await new Promise(resolve => server.close(resolve)); db.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4173);
  const app = createApp();
  app.server.on('error', error => { console.error(`Could not start the project list: ${error.message}`); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => console.log(`Project list ready: http://127.0.0.1:${port}\nData: ${join(root, 'data', 'projects.sqlite')}\nLocal only. Press Ctrl+C to stop.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
