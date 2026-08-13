import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { getSession } from './index-store.js';
import { buildReview, reviewToMarkdown } from './review.js';

/**
 * Session collaboration (read-only "peek"): each session has an allowlist of OTHER
 * sessions it is permitted to read. The list is the single source of truth,
 * enforced server-side (and by the MCP `peers` server) — never trusted from the
 * calling model. Stored as one JSON file so edits take effect immediately for the
 * next tool call / next turn.
 */
const PEERS_FILE = path.join(DATA_DIR, 'peers.json');

interface PeerEntry {
  peers: string[];
}
type Registry = Record<string, PeerEntry>;

function readRegistry(): Registry {
  try {
    const o = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8'));
    return o && typeof o === 'object' ? (o as Registry) : {};
  } catch {
    return {};
  }
}

function writeRegistry(reg: Registry): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PEERS_FILE, JSON.stringify(reg, null, 2));
}

/** The peer ids session `id` may read (empty = collaboration off for this session). */
export function getPeers(id: string): string[] {
  const e = readRegistry()[id];
  return Array.isArray(e?.peers) ? e!.peers : [];
}

/** Replace session `id`'s allowlist. De-dupes, drops blanks and self-references. */
export function setPeers(id: string, peers: string[]): string[] {
  const reg = readRegistry();
  const clean = [...new Set((peers || []).filter((p) => typeof p === 'string' && p.trim() && p !== id))];
  if (clean.length) reg[id] = { peers: clean };
  else delete reg[id];
  writeRegistry(reg);
  return clean;
}

export interface PeerSummary {
  id: string;
  title: string;
  cwd: string | null;
  gitBranch: string | null;
  updatedAt: string | null;
  found: boolean;
}

/** Lightweight summaries for a set of peer ids (for `list_peers` / the UI). */
export function peerSummaries(ids: string[]): PeerSummary[] {
  return ids.map((id) => {
    const s = getSession(id);
    return s
      ? { id, title: s.title, cwd: s.cwd, gitBranch: s.gitBranch, updatedAt: s.updatedAt, found: true }
      : { id, title: '(session not found)', cwd: null, gitBranch: null, updatedAt: null, found: false };
  });
}

/** The de-noised Markdown review of a peer session, or null if it doesn't exist. */
export function peerReviewMarkdown(id: string): string | null {
  const s = getSession(id);
  return s ? reviewToMarkdown(buildReview(s)) : null;
}
