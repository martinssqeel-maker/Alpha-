/**
 * Persistent semantic memory graph.
 *
 * Everything here is local: rows live in `alpha.db` (sql.js), and vectors come
 * from a local embedding model when one is configured. When it is not — Ollama
 * not installed, model not pulled, provider offline — the graph degrades to a
 * deterministic hashed bag-of-n-grams embedding rather than failing, so recall
 * still works offline and tests never need a model.
 *
 * Deliberately no `electron` import: this module must stay loadable by Vitest.
 */
import { createHash, randomUUID } from 'node:crypto'

export type MemoryKind = 'code' | 'preference' | 'solution' | 'failure' | 'note'

export interface MemoryEntryInput {
  kind: MemoryKind
  text: string
  /** Extra searchable context: file path, tool name, project id. */
  meta?: string
  /** Importance multiplier; a user preference outranks a routine note. */
  weight?: number
}

export interface MemoryHit {
  id: string
  kind: MemoryKind
  text: string
  meta: string | null
  score: number
  weight: number
  createdAt: number
}

/** The slice of `Db` this module needs, so tests can pass a fake. */
export interface MemoryStore {
  run(sql: string, params?: Array<string | number | Uint8Array | null>): void
  all<T = Record<string, unknown>>(
    sql: string,
    params?: Array<string | number | Uint8Array | null>
  ): T[]
}

export interface EmbeddingProvider {
  /** One vector per input text. Must throw on failure; the graph falls back. */
  embed(texts: string[]): Promise<number[][]>
}

const HASH_DIMS = 128
const CHUNK_CHARS = 800
const CHUNK_OVERLAP = 80
const MAX_TEXT_CHARS = 4_000

/** FNV-1a over a token, used to pick a bucket in the fallback embedding. */
function tokenHash(token: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Deterministic offline embedding: character trigrams and word tokens hashed
 * into a fixed-width vector, then L2-normalised.
 *
 * This is not a semantic model — it is lexical similarity with a stable shape,
 * which is enough to make recall useful offline and makes every test
 * reproducible without a model.
 */
export function hashEmbedding(text: string, dims = HASH_DIMS): number[] {
  const vector = new Array<number>(dims).fill(0)
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!normalised) return vector
  for (const word of normalised.split(' ')) {
    if (!word) continue
    const wb = tokenHash(word) % dims
    vector[wb] += 2
    const padded = `#${word}#`
    for (let i = 0; i + 3 <= padded.length; i++) {
      vector[tokenHash(padded.slice(i, i + 3)) % dims] += 1
    }
  }
  let norm = 0
  for (const v of vector) norm += v * v
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < dims; i++) vector[i] /= norm
  return vector
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function toBlob(vector: readonly number[]): Uint8Array {
  const out = new Uint8Array(vector.length * 4)
  const view = new DataView(out.buffer)
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true)
  return out
}

export function fromBlob(blob: Uint8Array | ArrayBuffer | null | undefined): number[] {
  if (!blob) return []
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[] = []
  for (let i = 0; i + 4 <= bytes.byteLength; i += 4) out.push(view.getFloat32(i, true))
  return out
}

/** Split long text on paragraph/line boundaries with a small overlap. */
export function chunkText(text: string, maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]
  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length)
    if (end < clean.length) {
      const boundary = Math.max(clean.lastIndexOf('\n\n', end), clean.lastIndexOf('\n', end))
      if (boundary > start + maxChars / 2) end = boundary
    }
    const piece = clean.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

export interface MemoryGraphDeps {
  db: MemoryStore
  /** Optional local model. Absent or failing means the hash fallback is used. */
  embedder?: EmbeddingProvider | null
  now?: () => number
}

/**
 * Recall and storage over `memory_chunks`. Searches brute-force cosine over a
 * bounded candidate window — honest for thousands of rows, and documented as
 * such rather than pretending there is an ANN index behind it.
 */
export class MemoryGraph {
  private now: () => number
  private embedder: EmbeddingProvider | null
  /** Set after the first provider failure so we stop paying a timeout per write. */
  private embedderCooldownUntil = 0

  constructor(private deps: MemoryGraphDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.embedder = deps.embedder ?? null
  }

  get semanticEnabled(): boolean {
    return this.embedder !== null
  }

  private async embedOne(text: string): Promise<number[]> {
    const embedder = this.embedder
    if (embedder && this.now() >= this.embedderCooldownUntil) {
      try {
        const [vector] = await embedder.embed([text])
        if (vector && vector.length > 0) return vector
      } catch {
        // A dead provider must not break a turn; back off for a minute.
        this.embedderCooldownUntil = this.now() + 60_000
      }
    }
    return hashEmbedding(text)
  }

  /** Index a text under a kind. Long text is chunked; duplicates are skipped. */
  async remember(input: MemoryEntryInput): Promise<number> {
    const text = (input.text ?? '').trim().slice(0, MAX_TEXT_CHARS)
    if (!text) return 0
    const chunks = chunkText(text)
    const weight = clamp(input.weight ?? 1, 0.1, 10)
    let stored = 0
    for (const chunk of chunks) {
      const hash = contentHash(chunk)
      const existing = this.deps.db.all<{ id: string }>(
        'SELECT id FROM memory_chunks WHERE hash = ? AND kind = ?',
        [hash, input.kind]
      )
      if (existing.length) {
        this.deps.db.run(
          'UPDATE memory_chunks SET weight = MAX(weight, ?), last_used_at = ? WHERE id = ?',
          [weight, this.now(), existing[0].id]
        )
        continue
      }
      const vector = await this.embedOne(`${input.kind} ${chunk}`)
      this.deps.db.run(
        `INSERT INTO memory_chunks (id, kind, text, meta, vector, dim, hash, weight, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          randomUUID(),
          input.kind,
          chunk,
          input.meta ?? null,
          toBlob(vector),
          vector.length,
          hash,
          weight,
          this.now()
        ]
      )
      stored++
    }
    return stored
  }

  /** Top-k by cosine similarity, with weight applied as a mild multiplier. */
  async search(query: string, options: { limit?: number; kind?: MemoryKind; minScore?: number } = {}): Promise<MemoryHit[]> {
    const q = (query ?? '').trim()
    if (!q) return []
    const limit = clamp(options.limit ?? 8, 1, 50)
    const minScore = options.minScore ?? 0.05
    const vectors = await this.embedVector(q)
    // Candidate window: bounded so a huge memory file cannot stall a turn.
    const rows = this.deps.db.all<{
      id: string
      kind: MemoryKind
      text: string
      meta: string | null
      vector: Uint8Array
      weight: number
      created_at: number
    }>(
      options.kind
        ? 'SELECT id, kind, text, meta, vector, weight, created_at FROM memory_chunks WHERE kind = ? ORDER BY weight DESC, created_at DESC LIMIT 5000'
        : 'SELECT id, kind, text, meta, vector, weight, created_at FROM memory_chunks ORDER BY weight DESC, created_at DESC LIMIT 5000',
      options.kind ? [options.kind] : []
    )
    const scored = rows
      .map((row) => {
        const score = cosine(vectors, fromBlob(row.vector)) * (0.75 + 0.25 * clamp(row.weight, 0.1, 10))
        return {
          id: row.id,
          kind: row.kind,
          text: row.text,
          meta: row.meta,
          score,
          weight: row.weight,
          createdAt: Number(row.created_at)
        }
      })
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    for (const hit of scored) {
      this.deps.db.run('UPDATE memory_chunks SET last_used_at = ? WHERE id = ?', [this.now(), hit.id])
    }
    return scored
  }

  private async embedVector(query: string): Promise<number[]> {
    // Query and documents must share a space; use the provider when it works,
    // otherwise the same hash fallback the stored rows were written with.
    if (this.embedder && this.now() >= this.embedderCooldownUntil) {
      try {
        const [vector] = await this.embedder.embed([query])
        if (vector && vector.length) return vector
      } catch {
        this.embedderCooldownUntil = this.now() + 60_000
      }
    }
    return hashEmbedding(query)
  }

  /**
   * Memory block for the system prompt. Bounded by characters, because this sits
   * inside a 24k history budget and must never crowd out the actual request.
   */
  async contextBlock(query: string, budgetChars = 1_200): Promise<string> {
    const hits = await this.search(query, { limit: 6 })
    if (!hits.length) return ''
    const lines: string[] = []
    let used = 0
    for (const hit of hits) {
      const line = `- [${hit.kind}] ${hit.text.replace(/\s+/g, ' ').slice(0, 240)}${hit.meta ? ` (${hit.meta})` : ''}`
      if (used + line.length > budgetChars) break
      lines.push(line)
      used += line.length + 1
    }
    return lines.length ? `Relevant memory from previous sessions:\n${lines.join('\n')}` : ''
  }

  stats(): { total: number; byKind: Record<string, number>; semantic: boolean } {
    const rows = this.deps.db.all<{ kind: string; n: number }>(
      'SELECT kind, COUNT(*) as n FROM memory_chunks GROUP BY kind'
    )
    const byKind: Record<string, number> = {}
    let total = 0
    for (const row of rows) {
      byKind[row.kind] = Number(row.n)
      total += Number(row.n)
    }
    return { total, byKind, semantic: this.semanticEnabled }
  }

  /** Keep the newest/highest-weight rows; called on startup to bound the file. */
  prune(maxRows = 5_000): number {
    const row = this.deps.db.all<{ n: number }>('SELECT COUNT(*) as n FROM memory_chunks')
    const total = Number(row[0]?.n ?? 0)
    if (total <= maxRows) return 0
    this.deps.db.run(
      `DELETE FROM memory_chunks WHERE id NOT IN (
         SELECT id FROM memory_chunks ORDER BY weight DESC, created_at DESC LIMIT ?
       )`,
      [maxRows]
    )
    return total - maxRows
  }

  clear(): void {
    this.deps.db.run('DELETE FROM memory_chunks')
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}
