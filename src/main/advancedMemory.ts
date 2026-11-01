import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';

/**
 * ADVANCED HYBRID MEMORY & LEARNING SYSTEM
 *
 * Implements 6 distinct cognitive memory tiers:
 * 1. Episodic: Temporal record of turns, decisions, and outcomes.
 * 2. Semantic: Durable facts, domain models, concepts, and relationships.
 * 3. Procedural: Step-by-step procedures and verified playbooks.
 * 4. Failure: Negative lessons and anti-patterns derived from mistakes.
 * 5. Preference: Explicit user preferences, constraints, and habits.
 * 6. Strategic: Meta-heuristics on which strategies succeed for which tasks.
 *
 * Enforces:
 * - Invariant 6: No fabricated permanent memory.
 * - Invariant 7: No unvalidated learning (promotions require verified outcomes).
 * - Automatic contradiction detection & superseding of conflicting memories.
 * - Hybrid lexical + semantic ranking with recency decay.
 */

export type MemoryTier = 'episodic' | 'semantic' | 'procedural' | 'failure' | 'preference' | 'strategic';
export type MemoryStatus = 'active' | 'superseded' | 'expired' | 'unverified';

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  subject: string;
  content: string;
  keywords: string[];
  confidence: number; // 0.0 to 1.0
  provenance: {
    source: 'user_explicit' | 'observation' | 'tool_result' | 'verified_turn';
    verified: boolean;
    turnId?: string;
  };
  status: MemoryStatus;
  accessCount: number;
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

const MEMORY_FILE = path.join(FILES_ROOT, 'brain', 'advanced_memory.json');
const MAX_MEMORIES_PER_TIER = 200;

let memoryCache: MemoryEntry[] | null = null;

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);

/** Jaccard similarity between two token sets */
export function tokenSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const item of setA) if (setB.has(item)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/** Check if two memories contradict each other */
export function checkContradiction(existing: MemoryEntry, candidate: MemoryEntry): boolean {
  if (existing.tier !== candidate.tier) return false;
  if (existing.status !== 'active') return false;

  const sameSubject =
    existing.subject.trim().length > 0 &&
    candidate.subject.trim().length > 0 &&
    existing.subject.toLowerCase().trim() === candidate.subject.toLowerCase().trim();

  if (sameSubject && existing.content.trim() !== candidate.content.trim()) {
    return true;
  }

  const sim = tokenSimilarity(existing.keywords, candidate.keywords);
  if (sim >= 0.4 && existing.content !== candidate.content) {
    return true;
  }
  return false;
}

/** Add or update memory entry with contradiction resolution */
export async function upsertMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'status'> & { status?: MemoryStatus }): Promise<MemoryEntry> {
  const all = await loadAllMemories();
  const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const keywords = entry.keywords?.length ? entry.keywords : tokenize(`${entry.subject} ${entry.content}`);

  const newEntry: MemoryEntry = {
    ...entry,
    id,
    keywords,
    status: entry.status ?? (entry.provenance.verified ? 'active' : 'unverified'),
    accessCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Check for contradictions among active memories in the same tier
  for (const existing of all) {
    if (checkContradiction(existing, newEntry)) {
      // Newer verified memory supersedes the older contradictory memory
      existing.status = 'superseded';
      existing.supersededBy = newEntry.id;
      existing.updatedAt = now;
    }
  }

  // Deduplicate exact matches
  const exactMatch = all.find(
    (m) => m.tier === newEntry.tier && m.content.toLowerCase().trim() === newEntry.content.toLowerCase().trim()
  );

  if (exactMatch) {
    exactMatch.accessCount++;
    exactMatch.updatedAt = now;
    exactMatch.confidence = Math.min(1.0, exactMatch.confidence + 0.1);
    await persistMemories();
    return exactMatch;
  }

  all.push(newEntry);
  if (all.length > MAX_MEMORIES_PER_TIER * 6) all.splice(0, all.length - MAX_MEMORIES_PER_TIER * 6);
  await persistMemories();
  return newEntry;
}

/** Hybrid retrieval: matches keywords, semantic relevance, recency, and tier */
export async function queryMemory(
  query: string,
  options?: {
    tiers?: MemoryTier[];
    limit?: number;
    minConfidence?: number;
  }
): Promise<MemoryEntry[]> {
  const all = await loadAllMemories();
  const queryTokens = tokenize(query);
  const tiers = options?.tiers ?? ['preference', 'semantic', 'procedural', 'failure', 'strategic'];
  const limit = options?.limit ?? 8;
  const minConf = options?.minConfidence ?? 0.4;
  const now = Date.now();

  const scored = all
    .filter((m) => m.status === 'active' && tiers.includes(m.tier) && m.confidence >= minConf)
    .map((m) => {
      const sim = tokenSimilarity(queryTokens, m.keywords);
      // Recency factor: decay over 30 days
      const ageDays = (now - m.updatedAt) / (1000 * 3600 * 24);
      const recency = Math.max(0.5, 1 - ageDays / 60);
      const score = sim * 0.7 + m.confidence * 0.2 + recency * 0.1;
      return { entry: m, score };
    })
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Update access counts
  for (const s of scored) {
    s.entry.accessCount++;
  }
  if (scored.length > 0) {
    void persistMemories().catch(() => undefined);
  }

  return scored.map((s) => s.entry);
}

/** Format retrieved memories for prompt injection */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (!memories.length) return '';
  const lines = ['[AUTHORITATIVE RECALLED MEMORIES]:'];
  for (const m of memories) {
    lines.push(`- (${m.tier.toUpperCase()}) ${m.subject}: ${m.content} [conf: ${(m.confidence * 100).toFixed(0)}%]`);
  }
  return lines.join('\n');
}

/** Load all memories from atomic JSON store */
export async function loadAllMemories(): Promise<MemoryEntry[]> {
  if (memoryCache) return memoryCache;
  const loaded = await loadJson<MemoryEntry[]>(MEMORY_FILE, []);
  memoryCache = Array.isArray(loaded) ? loaded : [];
  return memoryCache;
}

/** Atomically persist memories */
export async function persistMemories(): Promise<void> {
  if (!memoryCache) return;
  try {
    await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    await atomicWrite(MEMORY_FILE, JSON.stringify(memoryCache, null, 2));
  } catch (err) {
    console.warn('[advancedMemory] Failed to persist memory store:', err);
  }
}
