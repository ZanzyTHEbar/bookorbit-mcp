import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  BookOrbitApiError,
  BookOrbitClient,
  type BookIdentity,
  type BookRequestAvailability,
  type BookRequestItem,
  type BookRequestSubmitResult,
  type MetadataCandidate,
} from "./bookorbit.ts";
import { HistoryStore, type HistoryRecord, type RequestState } from "./history.ts";

const bookSchema = z.object({
  title: z.string().trim().min(1).max(500),
  authors: z.array(z.string().max(255)).max(50).optional(),
  isbn10: z.string().max(20).optional(),
  isbn13: z.string().max(20).optional(),
  providerKey: z.string().max(50).optional(),
  providerId: z.string().max(255).optional(),
  subtitle: z.string().max(500).optional(),
  seriesName: z.string().max(500).optional(),
  seriesIndex: z.union([z.number().int().min(0), z.string()]).optional(),
  publishedYear: z.number().int().min(0).max(9999).optional(),
  language: z.string().max(20).optional(),
  coverUrl: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)).optional(),
  mediaKind: z.literal("ebook").default("ebook"),
});

const toolBookSchema = bookSchema.omit({ subtitle: true, seriesName: true, seriesIndex: true, publishedYear: true, language: true, coverUrl: true });
type ToolBook = z.infer<typeof bookSchema>;

function identity(book: ToolBook): BookIdentity {
  return {
    title: book.title,
    authors: book.authors,
    isbn10: book.isbn10,
    isbn13: book.isbn13,
    providerKey: book.providerKey,
    providerId: book.providerId,
    mediaKind: book.mediaKind,
  };
}

function requestLink(baseUrl: string, requestId: number): string {
  return new URL(`/requests/${requestId}`, baseUrl).toString();
}

function bookLink(baseUrl: string, bookId: number): string {
  return new URL(`/book/${bookId}`, baseUrl).toString();
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function safeTool<A>(handler: (args: A) => Promise<Record<string, unknown>>) {
  return async (args: A) => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      const message = error instanceof BookOrbitApiError || error instanceof AdapterError
        ? error.message
        : "BookOrbit adapter operation failed; inspect the saved history and deployment health.";
      return toolError(message);
    }
  };
}

class AdapterError extends Error {}

function normalizeMatch(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function metadataScore(candidate: MetadataCandidate, query: { title: string; author?: string; isbn?: string; publishedYear?: number }): number {
  const title = normalizeMatch(query.title);
  const candidateTitle = normalizeMatch(candidate.title ?? "");
  const author = normalizeMatch(query.author ?? "");
  const candidateAuthors = (candidate.authors ?? []).map(normalizeMatch);
  const isbn = (query.isbn ?? "").replace(/[^0-9X]/gi, "").toUpperCase();
  return (candidateTitle === title ? 8 : candidateTitle && (candidateTitle.includes(title) || title.includes(candidateTitle)) ? 3 : 0)
    + (author && candidateAuthors.some((item) => item === author) ? 12 : author && candidateAuthors.some((item) => item.includes(author) || author.includes(item)) ? 5 : 0)
    + (query.publishedYear && candidate.publishedYear ? (candidate.publishedYear === query.publishedYear ? 24 : -4) : 0)
    + (isbn && [candidate.isbn10, candidate.isbn13].some((item) => item?.replace(/[^0-9X]/gi, "").toUpperCase() === isbn) ? 16 : 0);
}

function publicHistory(record: HistoryRecord): Record<string, unknown> {
  return {
    ...record,
    link: record.requestLink,
    status: record.requestState === "retryable" || record.requestState === "unknown" || record.requestState === "requesting"
      ? "failed"
      : record.requestState,
    retryable: record.requestState === "retryable",
    idempotencyKey: record.workKey,
  };
}

function statusForAvailability(availability: BookRequestAvailability, baseUrl: string) {
  if (availability.ownedBookId !== null) {
    return {
      status: "already_available",
      bookId: availability.ownedBookId,
      link: bookLink(baseUrl, availability.ownedBookId),
    };
  }
  if (availability.existingRequestId !== null) {
    return {
      status: "already_requested",
      requestId: availability.existingRequestId,
      requestStatus: availability.existingRequestStatus,
      link: requestLink(baseUrl, availability.existingRequestId),
    };
  }
  return { status: "missing", requestId: null, requestStatus: null, link: null };
}

function identityFromRequest(request: BookRequestItem): BookIdentity {
  const authors = Array.isArray(request.authors) ? request.authors.filter((author): author is string => typeof author === "string") : [];
  return {
    title: request.title,
    authors,
    isbn10: typeof request.isbn10 === "string" ? request.isbn10 : undefined,
    isbn13: typeof request.isbn13 === "string" ? request.isbn13 : undefined,
    providerKey: typeof request.providerKey === "string" ? request.providerKey : undefined,
    providerId: typeof request.providerId === "string" ? request.providerId : undefined,
    mediaKind: request.mediaKind,
  };
}

function stateFromRequestStatus(status: string): RequestState {
  if (status === "available") return "already_available";
  if (["failed", "rejected", "cancelled"].includes(status)) return "failed";
  return "already_requested";
}

function updateOutcome(
  history: HistoryStore,
  book: BookIdentity,
  state: RequestState,
  baseUrl: string,
  request?: BookRequestItem,
  error?: string,
): HistoryRecord {
  return history.saveRequestOutcome(book, {
    state,
    requestId: request?.id ?? null,
    requestStatus: request?.status ?? null,
    requestLink: request ? requestLink(baseUrl, request.id) : null,
    error: error ?? null,
  });
}

export function createRequestBookHandler(client: BookOrbitClient, history: HistoryStore, baseUrl: string) {
  return async (input: {
    book: ToolBook;
    technicalWork: boolean;
  }): Promise<Record<string, unknown>> => {
    const book = identity(input.book);
    const previous = history.get(book);
    if (previous && previous.requestState !== "not_requested" && previous.requestState !== "retryable") {
      if (previous.requestState !== "requesting" && previous.requestState !== "unknown") {
        return publicHistory(previous);
      }
    }

    const reservation = history.reserveRequest(book);
    const reconcileOnly = !reservation.reserved;
    if (reconcileOnly && reservation.record.requestState !== "requesting" && reservation.record.requestState !== "unknown") {
      return publicHistory(reservation.record);
    }

    let availability: BookRequestAvailability;
    try {
      const [found] = await client.checkAvailability([book]);
      if (!found) throw new AdapterError("BookOrbit returned no availability result.");
      availability = found;
    } catch (error) {
      if (!reconcileOnly) history.saveRequestOutcome(book, { state: "retryable", error: "Availability check failed before submission." });
      throw error instanceof AdapterError ? error : new AdapterError("BookOrbit availability check failed; no request was submitted.");
    }

    if (availability.ownedBookId !== null) {
      const record = history.saveRequestOutcome(book, {
        state: "already_available",
        requestLink: bookLink(baseUrl, availability.ownedBookId),
      });
      return { ...publicHistory(record), bookId: availability.ownedBookId };
    }
    if (availability.existingRequestId !== null) {
      const record = history.saveRequestOutcome(book, {
        state: "already_requested",
        requestId: availability.existingRequestId,
        requestStatus: availability.existingRequestStatus,
        requestLink: requestLink(baseUrl, availability.existingRequestId),
      });
      return publicHistory(record);
    }
    if (reconcileOnly) {
      const record = history.saveRequestOutcome(book, {
        state: "unknown",
        error: "No active request was found for a previous uncertain submission; no second request was sent.",
      });
      return publicHistory(record);
    }

    let submitStarted = false;
    try {
      const destinations = await client.getDefaultDestinations();
      const destination = destinations.ebook;
      if (!destination) throw new AdapterError("BookOrbit has no default e-book destination configured.");

      submitStarted = true;
      const result: BookRequestSubmitResult = await client.createRequest({
        title: input.book.title,
        mediaKind: "ebook",
        subtitle: input.book.subtitle,
        authors: input.book.authors,
        seriesName: input.book.seriesName,
        seriesIndex: typeof input.book.seriesIndex === "number" ? input.book.seriesIndex : undefined,
        isbn10: input.book.isbn10,
        isbn13: input.book.isbn13,
        publishedYear: input.book.publishedYear,
        language: "en",
        coverUrl: input.book.coverUrl,
        providerKey: input.book.providerKey,
        providerId: input.book.providerId,
        preferredFormats: input.technicalWork ? ["epub", "pdf"] : ["epub"],
        targetLibraryId: destination.libraryId,
        targetFolderId: destination.folderId ?? undefined,
        selfServe: false,
      });
      const state: RequestState = result.subscribed ? "already_requested" : "newly_requested";
      const record = updateOutcome(history, book, state, baseUrl, result.request);
      return publicHistory(record);
    } catch (error) {
      if (!submitStarted) {
        const detail = error instanceof Error ? error.message : "Request could not be submitted.";
        const record = history.saveRequestOutcome(book, { state: "retryable", error: detail });
        return publicHistory(record);
      }
      if (error instanceof BookOrbitApiError && error.status < 500) {
        const detail = error instanceof Error ? error.message : "Request could not be submitted.";
        const record = history.saveRequestOutcome(book, { state: "failed", error: detail });
        return publicHistory(record);
      }
      const record = history.saveRequestOutcome(book, {
        state: "unknown",
        error: "BookOrbit did not confirm whether the request was created; a retry will reconcile but will not submit again.",
      });
      return publicHistory(record);
    }
  };
}

export function createMcpServer(client: BookOrbitClient, history: HistoryStore, baseUrl: string): McpServer {
  const server = new McpServer({ name: "bookorbit-mcp", version: "0.1.0" });
  const requestBook = createRequestBookHandler(client, history, baseUrl);

  server.registerTool("search_books", {
    title: "Search BookOrbit metadata",
    description: "Resolve a title, author, year, or ISBN to BookOrbit book metadata, ISBNs, and editions. Searches e-books and ranks the closest edition first.",
    inputSchema: {
      title: z.string().trim().min(1).max(500),
      author: z.string().trim().max(255).optional(),
      isbn: z.string().trim().max(30).optional(),
      publishedYear: z.number().int().min(1000).max(3000).optional(),
      limit: z.number().int().min(1).max(20).default(20),
    },
  }, safeTool(async ({ title, author, isbn, publishedYear, limit }) => {
    const result = await client.searchBooks({ title, author, isbn, mediaKind: "ebook" });
    const candidates = result.candidates
      .map((candidate, index) => ({ candidate, index, score: metadataScore(candidate, { title, author, isbn, publishedYear }) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ candidate }) => candidate);
    return {
      candidates: candidates.slice(0, limit).map((candidate) => ({
        provider: candidate.provider,
        providerKey: candidate.provider,
        providerId: candidate.providerId,
        title: candidate.title,
        subtitle: candidate.subtitle,
        authors: candidate.authors,
        isbn10: candidate.isbn10,
        isbn13: candidate.isbn13,
        seriesName: candidate.seriesName,
        seriesIndex: candidate.seriesIndex,
        publishedYear: candidate.publishedYear,
        language: candidate.language,
        coverUrl: candidate.coverUrl,
        sourceUrl: candidate.sourceUrl,
      })),
      providerStatuses: result.providerStatuses,
      truncated: candidates.length > limit,
    };
  }));

  server.registerTool("find_existing_books", {
    title: "Find existing books and requests",
    description: "Check candidate e-books against accessible library copies and active BookOrbit requests.",
    inputSchema: { books: z.array(toolBookSchema).min(1).max(50) },
  }, safeTool(async ({ books }) => {
    const availability = await client.checkAvailability(books.map(identity));
    return {
      items: books.map((book, index) => ({
        book,
        ...(availability[index] ? statusForAvailability(availability[index]!, baseUrl) : { status: "failed" }),
      })),
    };
  }));

  server.registerTool("request_book", {
    title: "Request an e-book",
    description: "Request a resolved English e-book. EPUB is preferred; PDF is included only for technical works. Uses one idempotent request per book and medium.",
    inputSchema: {
      book: bookSchema,
      technicalWork: z.boolean().default(false),
    },
  }, safeTool(requestBook));

  server.registerTool("get_request_status", {
    title: "Get BookOrbit request status",
    description: "Return the current BookOrbit request state and its BookOrbit link.",
    inputSchema: { requestId: z.number().int().positive() },
  }, safeTool(async ({ requestId }) => {
    const request = await client.getRequest(requestId);
    const link = requestLink(baseUrl, request.id);
    history.saveRequestOutcome(identityFromRequest(request), {
      state: stateFromRequestStatus(request.status),
      requestId: request.id,
      requestStatus: request.status,
      requestLink: link,
    });
    return { requestId: request.id, status: request.status, title: request.title, mediaKind: request.mediaKind, link };
  }));

  server.registerTool("record_book_event", {
    title: "Record a recommendation or feedback",
    description: "Persist a book recommendation or the user's feedback for future reading-task runs. Reuse eventId when retrying the same event.",
    inputSchema: {
      type: z.enum(["recommendation", "feedback"]),
      book: bookSchema,
      source: z.string().max(200).optional(),
      feedback: z.string().trim().max(2000).optional(),
      eventId: z.string().trim().min(1).max(200).optional(),
    },
  }, safeTool(async ({ type, book, source, feedback, eventId }) => {
    let record: HistoryRecord;
    if (type === "feedback") {
      if (!feedback) throw new AdapterError("Feedback text is required.");
      record = history.recordBookEvent({ type, book: identity(book), source, feedback, eventId });
    } else {
      record = history.recordBookEvent({ type, book: identity(book), source, eventId });
    }
    return publicHistory(record);
  }));

  server.registerTool("get_reading_history", {
    title: "Get reading recommendation history",
    description: "Return adapter-stored recommendations, BookOrbit request IDs/states, and feedback.",
    inputSchema: {
      query: z.string().trim().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    },
  }, safeTool(async ({ query, limit, offset }) => ({
    items: history.list({ query, limit, offset }).map(publicHistory),
  })));

  return server;
}

export function startMcpService(options: {
  baseUrl: string;
  refreshToken?: string;
  historyPath: string;
  port: number;
  fetcher?: typeof fetch;
}) {
  const history = new HistoryStore(options.historyPath);
  if (!history.getSecret("bookorbit_refresh_token")) {
    if (!options.refreshToken?.trim()) {
      history.close();
      throw new Error("BOOKORBIT_REFRESH_TOKEN is required for the first OIDC session bootstrap");
    }
    history.setSecret("bookorbit_refresh_token", options.refreshToken.trim());
  }
  const client = new BookOrbitClient({
    baseUrl: options.baseUrl,
    getRefreshToken: () => history.getSecret("bookorbit_refresh_token"),
    saveRefreshToken: (refreshToken) => history.setSecret("bookorbit_refresh_token", refreshToken),
    fetcher: options.fetcher,
  });
  const handleMcpRequest = async (request: Request): Promise<Response> => {
    const mcp = createMcpServer(client, history, options.baseUrl);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await mcp.close();
    }
  };

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: options.port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ status: "ok" });
      if (url.pathname === "/mcp") {
        if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
        return handleMcpRequest(request);
      }
      return new Response("Not found", { status: 404 });
    },
    error: (error) => {
      console.error(`[http] ${error.name}`);
      return new Response("Internal server error", { status: 500 });
    },
  });

  console.log(`BookOrbit MCP listening on port ${server.port}`);
  return {
    server,
    async close() {
      server.stop(true);
      history.close();
    },
  };
}
