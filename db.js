// server/db.js — 服务端 SQLite 存储（v4 Evidence-first 数据模型）
// 一级对象：主题（topic，长期存活）→ 线程（thread）→ 问题树（steps）→ 证据（evidence，跨线程复用）→ 报告版本（artifacts）
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "xbuddy.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  symbol TEXT,
  note TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'real',           -- real | replay（演示模式，轨迹重放）
  stage TEXT NOT NULL DEFAULT 'new',           -- new | clarifying | outline | running | report | done
  status TEXT NOT NULL DEFAULT 'active',       -- active | completed | archived | stopped
  context_summary TEXT NOT NULL DEFAULT '',    -- 工作记忆摘要
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                          -- user | assistant | system
  kind TEXT NOT NULL DEFAULT 'text',           -- text | clarify | outline | decision | intercept
  content_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | validated | running | done | stopped
  playbook TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',       -- {time_range, view, caliber}
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  node_id TEXT,                                -- 问题树节点 id（Q1/Q2…）
  parent_id TEXT,                              -- 父节点 id（问题树层级）
  title TEXT NOT NULL,
  sub_question TEXT,
  hypothesis TEXT,                             -- 假设（问题树节点必须声明）
  data_needed_json TEXT NOT NULL DEFAULT '[]', -- 所需数据清单
  kind TEXT NOT NULL DEFAULT 'tool',           -- tool | analysis
  tool_name TEXT,
  args_json TEXT NOT NULL DEFAULT '{}',
  depends_on TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai_generated', -- ai_generated | user_added
  selected INTEGER NOT NULL DEFAULT 1,         -- 用户勾选（提纲卡可勾选）
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',-- 本节点产出的证据 id（执行投影）
  degrade_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | waiting_approval | running | succeeded | failed | degraded | skipped
  result_summary TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  plan_id INTEGER,
  upto_seq INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  step_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'tool',           -- tool | user（人工补充）
  label TEXT NOT NULL DEFAULT 'mock',          -- mock | real | user
  type TEXT NOT NULL DEFAULT 'market_data',    -- market_data | financial | valuation | news | macro | user_upload
  source TEXT NOT NULL,
  source_detail TEXT,                          -- 接口名/文件名/链接
  as_of TEXT,
  unit TEXT,
  caliber TEXT,
  metric TEXT,
  value_text TEXT,
  raw_ref TEXT,                                -- 原始字段路径（tool://... ）
  raw_snippet TEXT,                            -- 原文片段
  status TEXT NOT NULL DEFAULT 'ok',           -- ok | missing | stale | conflict
  conflict_with TEXT,                          -- 冲突对方证据 id（逗号分隔）
  primary_source INTEGER NOT NULL DEFAULT 0,   -- 冲突后用户指定的主源
  content_json TEXT NOT NULL DEFAULT '{}',
  starred INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER,
  thread_id INTEGER,
  scope TEXT NOT NULL DEFAULT 'task',          -- user | task
  status TEXT NOT NULL DEFAULT 'candidate',    -- candidate | active | archived
  content TEXT NOT NULL,
  source_evidence_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  step_id INTEGER,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  step_id INTEGER,
  action TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  reason TEXT NOT NULL,
  cost_estimate TEXT,
  data_volume TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  template TEXT NOT NULL DEFAULT 'risk_scan',
  content_json TEXT NOT NULL,
  compliance_json TEXT NOT NULL DEFAULT '{}',
  changelog TEXT NOT NULL DEFAULT '',          -- 版本变更说明（修订可溯）
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'system',
  message TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// ---------- 兼容迁移（旧库加列，全部幂等） ----------
function addCol(table, col, ddl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); } catch { /* 列已存在 */ }
}
addCol("threads", "llm_cfg_json", "TEXT NOT NULL DEFAULT '{}'");
addCol("threads", "topic_id", "INTEGER");
addCol("threads", "stage", "TEXT NOT NULL DEFAULT 'new'");
addCol("plans", "scope_json", "TEXT NOT NULL DEFAULT '{}'");
addCol("steps", "node_id", "TEXT");
addCol("steps", "parent_id", "TEXT");
addCol("steps", "sub_question", "TEXT");
addCol("steps", "hypothesis", "TEXT");
addCol("steps", "data_needed_json", "TEXT NOT NULL DEFAULT '[]'");
addCol("steps", "source", "TEXT NOT NULL DEFAULT 'ai_generated'");
addCol("steps", "selected", "INTEGER NOT NULL DEFAULT 1");
addCol("steps", "evidence_ids_json", "TEXT NOT NULL DEFAULT '[]'");
addCol("steps", "degrade_reason", "TEXT");
addCol("evidence", "topic_id", "INTEGER");
addCol("evidence", "type", "TEXT NOT NULL DEFAULT 'market_data'");
addCol("evidence", "source_detail", "TEXT");
addCol("evidence", "raw_ref", "TEXT");
addCol("evidence", "raw_snippet", "TEXT");
addCol("evidence", "status", "TEXT NOT NULL DEFAULT 'ok'");
addCol("evidence", "conflict_with", "TEXT");
addCol("evidence", "primary_source", "INTEGER NOT NULL DEFAULT 0");
addCol("memories", "topic_id", "INTEGER");
addCol("artifacts", "version", "INTEGER NOT NULL DEFAULT 1");
addCol("artifacts", "changelog", "TEXT NOT NULL DEFAULT ''");
addCol("artifacts", "is_current", "INTEGER NOT NULL DEFAULT 1");

export function lastInsertId(info) {
  return Number(info.lastInsertRowid);
}
