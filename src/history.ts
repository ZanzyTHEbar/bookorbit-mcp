import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { BookIdentity } from "./bookorbit.ts";

export type RequestState =
  | "not_requested"
  | "retryable"
  | "requesting"
  | "unknown"
  | "already_available"
  | "already_requested"
  | "newly_requested"
  | "failed";

export type BookEventInput =
  | { type: "recommendation"; book: BookIdentity; source?: string; eventId?: string }
  | { type: "feedback"; book: BookIdentity; source?: string; feedback: string; eventId?: string };

export interface BookHistoryEvent {
  eventId: string;
  type: "recommendation" | "feedback";
  source: string | null;
  feedback: string | null;
  createdAt: string;
}

export interface RequestOutcome {
  state: RequestState;
  requestId?: number | null;
  requestStatus?: string | null;
  requestLink?: string | null;
  error?: string | null;
}

export interface HistoryRecord {
  workKey: string;
  book: BookIdentity;
  recommendationSources: string[];
  recommendedAt: string | null;
  feedback: string | null;
  feedbackAt: string | null;
  requestState: RequestState;
  requestId: number | null;
  requestStatus: string | null;
  requestLink: string | null;
  lastError: string | null;
  updatedAt: string;
  events: BookHistoryEvent[];
}

interface HistoryRow {
  work_key: string;
  media_kind: BookIdentity["mediaKind"];
  title: string;
  authors_json: string;
  isbn10: string | null;
  isbn13: string | null;
  provider_key: string | null;
  provider_id: string | null;
  recommendation_sources_json: string;
  recommended_at: string | null;
  feedback: string | null;
  feedback_at: string | null;
  request_state: RequestState;
  request_id: number | null;
  request_status: string | null;
  request_link: string | null;
  last_error: string | null;
  updated_at: string;
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function bookWorkKey(book: BookIdentity): string {
  // Match BookOrbit's work-level dedupe: editions of one title/author/media share a request key.
  const identity = `work:${normalized(book.title)}:${normalized(book.authors?.[0] ?? "")}`;
  return createHash("sha256").update(`${book.mediaKind}\0${identity}`).digest("hex");
}

export class HistoryStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS book_history (
        work_key TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL,
        isbn10 TEXT,
        isbn13 TEXT,
        provider_key TEXT,
        provider_id TEXT,
        recommendation_sources_json TEXT NOT NULL DEFAULT '[]',
        recommended_at TEXT,
        feedback TEXT,
        feedback_at TEXT,
        request_state TEXT NOT NULL DEFAULT 'not_requested',
        request_id INTEGER UNIQUE,
        request_status TEXT,
        request_link TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (work_key, media_kind)
      );
      CREATE TABLE IF NOT EXISTS book_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_key TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT,
        feedback TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (work_key, media_kind, event_id)
      );
      CREATE TABLE IF NOT EXISTS adapter_secrets (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  getSecret(name: string): string | null {
    const row = this.db.query("SELECT value FROM adapter_secrets WHERE name = ?").get(name) as { value: string } | null;
    return row?.value ?? null;
  }

  setSecret(name: string, value: string): void {
    this.db.query(`
      INSERT INTO adapter_secrets (name, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(name, value, new Date().toISOString());
  }

  recordBookEvent(event: BookEventInput): HistoryRecord {
    if (event.type === "feedback" && !event.feedback?.trim()) throw new Error("feedback text is required for feedback events");
    const key = this.upsertIdentity(event.book);
    const now = new Date().toISOString();
    const eventId = event.eventId?.trim() || randomUUID();
    const feedback = event.type === "feedback" ? event.feedback.trim() : null;
    const inserted = this.db.query(`
      INSERT OR IGNORE INTO book_events (work_key, media_kind, event_id, type, source, feedback, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(key, event.book.mediaKind, eventId, event.type, event.source?.trim() ?? null, feedback, now);
    if (inserted.changes === 0) return this.getByKey(key, event.book.mediaKind)!;

    if (event.type === "recommendation") {
      const current = this.getByKey(key, event.book.mediaKind);
      const sources = new Set(current?.recommendationSources ?? []);
      if (event.source?.trim()) sources.add(event.source.trim());
      this.db.query(`
        UPDATE book_history
        SET recommendation_sources_json = ?, recommended_at = ?, updated_at = ?
        WHERE work_key = ? AND media_kind = ?
      `).run(JSON.stringify([...sources]), now, now, key, event.book.mediaKind);
    } else {
      this.db.query(`
        UPDATE book_history
        SET feedback = ?, feedback_at = ?, updated_at = ?
        WHERE work_key = ? AND media_kind = ?
      `).run(feedback, now, now, key, event.book.mediaKind);
    }

    return this.getByKey(key, event.book.mediaKind)!;
  }

  reserveRequest(book: BookIdentity): { reserved: boolean; record: HistoryRecord } {
    const key = this.upsertIdentity(book);
    const now = new Date().toISOString();
    const result = this.db.query(`
      UPDATE book_history SET request_state = 'requesting', last_error = NULL, updated_at = ?
      WHERE work_key = ? AND media_kind = ? AND request_state IN ('not_requested', 'retryable')
    `).run(now, key, book.mediaKind);
    return { reserved: result.changes === 1, record: this.getByKey(key, book.mediaKind)! };
  }

  saveRequestOutcome(book: BookIdentity, outcome: RequestOutcome): HistoryRecord {
    const key = this.upsertIdentity(book);
    const now = new Date().toISOString();
    this.db.query(`
      UPDATE book_history SET request_state = ?, request_id = ?, request_status = ?, request_link = ?, last_error = ?, updated_at = ?
      WHERE work_key = ? AND media_kind = ?
    `).run(
      outcome.state,
      outcome.requestId ?? null,
      outcome.requestStatus ?? null,
      outcome.requestLink ?? null,
      outcome.error ?? null,
      now,
      key,
      book.mediaKind,
    );
    return this.getByKey(key, book.mediaKind)!;
  }

  saveStatusByRequestId(requestId: number, requestStatus: string, requestLink: string): void {
    this.db.query(`
      UPDATE book_history SET request_status = ?, request_link = ?, updated_at = ?
      WHERE request_id = ?
    `).run(requestStatus, requestLink, new Date().toISOString(), requestId);
  }

  get(book: BookIdentity): HistoryRecord | null {
    return this.getByKey(bookWorkKey(book), book.mediaKind);
  }

  list(options: { query?: string; limit?: number; offset?: number } = {}): HistoryRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const offset = Math.max(0, options.offset ?? 0);
    const query = options.query?.trim();
    const rows = query
      ? this.db.query(`
          SELECT * FROM book_history
          WHERE title LIKE ? OR authors_json LIKE ? OR isbn13 LIKE ?
          ORDER BY updated_at DESC LIMIT ? OFFSET ?
        `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit, offset) as HistoryRow[]
      : this.db.query("SELECT * FROM book_history ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(limit, offset) as HistoryRow[];
    return rows.map((row) => this.toRecord(row));
  }

  close(): void {
    this.db.close();
  }

  private upsertIdentity(book: BookIdentity): string {
    const key = bookWorkKey(book);
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO book_history (
        work_key, media_kind, title, authors_json, isbn10, isbn13, provider_key, provider_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_key, media_kind) DO UPDATE SET
        title = excluded.title,
        authors_json = excluded.authors_json,
        isbn10 = COALESCE(excluded.isbn10, book_history.isbn10),
        isbn13 = COALESCE(excluded.isbn13, book_history.isbn13),
        provider_key = COALESCE(excluded.provider_key, book_history.provider_key),
        provider_id = COALESCE(excluded.provider_id, book_history.provider_id),
        updated_at = excluded.updated_at
    `).run(
      key,
      book.mediaKind,
      book.title,
      JSON.stringify(book.authors ?? []),
      book.isbn10 ?? null,
      book.isbn13 ?? null,
      book.providerKey ?? null,
      book.providerId ?? null,
      now,
    );
    return key;
  }

  private getByKey(key: string, mediaKind: BookIdentity["mediaKind"]): HistoryRecord | null {
    const row = this.db.query("SELECT * FROM book_history WHERE work_key = ? AND media_kind = ?").get(key, mediaKind) as HistoryRow | null;
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: HistoryRow): HistoryRecord {
    const events = this.db.query(`
      SELECT event_id, type, source, feedback, created_at
      FROM book_events WHERE work_key = ? AND media_kind = ? ORDER BY id
    `).all(row.work_key, row.media_kind) as Array<{
      event_id: string;
      type: "recommendation" | "feedback";
      source: string | null;
      feedback: string | null;
      created_at: string;
    }>;
    return {
      workKey: row.work_key,
      book: {
        title: row.title,
        authors: JSON.parse(row.authors_json) as string[],
        isbn10: row.isbn10 ?? undefined,
        isbn13: row.isbn13 ?? undefined,
        providerKey: row.provider_key ?? undefined,
        providerId: row.provider_id ?? undefined,
        mediaKind: row.media_kind,
      },
      recommendationSources: JSON.parse(row.recommendation_sources_json) as string[],
      recommendedAt: row.recommended_at,
      feedback: row.feedback,
      feedbackAt: row.feedback_at,
      requestState: row.request_state,
      requestId: row.request_id,
      requestStatus: row.request_status,
      requestLink: row.request_link,
      lastError: row.last_error,
      updatedAt: row.updated_at,
      events: events.map((event) => ({
        eventId: event.event_id,
        type: event.type,
        source: event.source,
        feedback: event.feedback,
        createdAt: event.created_at,
      })),
    };
  }
}
