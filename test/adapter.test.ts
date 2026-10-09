import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BookOrbitClient, parseMetadataSse, type BookIdentity, type CreateBookRequest, type MetadataCandidate } from "../src/bookorbit.ts";
import { createRequestBookHandler, startMcpService } from "../src/mcp.ts";
import { HistoryStore } from "../src/history.ts";

const book = {
  title: "The Dispossessed",
  authors: ["Ursula K. Le Guin"],
  isbn13: "9780061054884",
  mediaKind: "ebook" as const,
} satisfies BookIdentity;

describe("BookOrbit metadata stream", () => {
  it("parses candidates and provider status events from SSE", async () => {
    const body = new Response(
      [
        `data: ${JSON.stringify({ provider: "google", providerId: "edition-1", title: "The Dispossessed", isbn13: "9780061054884" })}`,
        "",
        `event: provider-status\ndata: ${JSON.stringify({ provider: "openLibrary", outcome: "timeout" })}`,
        "",
      ].join("\n"),
    ).body;

    const result = await parseMetadataSse(body!);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.providerId).toBe("edition-1");
    expect(result.providerStatuses).toEqual([{ provider: "openLibrary", outcome: "timeout" }]);
  });

  it("uses OIDC-issued refresh tokens and persists rotation for metadata searches", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    let currentRefreshToken = "oidc-refresh-token";
    const fetcher = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push({ url, init });
      if (url.pathname.endsWith("/auth/refresh")) {
        const presented = JSON.parse(String(init?.body)).refreshToken as string;
        currentRefreshToken = presented === "oidc-refresh-token" ? "rotated-refresh-token" : "rotated-again-token";
        return Response.json({
          accessToken: presented === "oidc-refresh-token" ? "old-access-token" : "access-token",
          refreshToken: currentRefreshToken,
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (new Headers(init?.headers).get("Authorization") === "Bearer old-access-token") {
        return new Response(null, { status: 401 });
      }
      return new Response(`data: ${JSON.stringify({ provider: "google", providerId: "edition-1", title: "The Dispossessed" })}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    const client = new BookOrbitClient({
      baseUrl: "https://books.example.test",
      getRefreshToken: () => currentRefreshToken,
      saveRefreshToken: (token) => { currentRefreshToken = token; },
      fetcher,
    });

    await client.searchBooks({ title: "The Dispossessed", mediaKind: "ebook" });

    expect(calls.map(({ url }) => url.pathname)).toEqual([
      "/api/v1/auth/refresh",
      "/api/v1/metadata-fetch/stream",
      "/api/v1/auth/refresh",
      "/api/v1/metadata-fetch/stream",
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ refreshToken: "oidc-refresh-token" });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ refreshToken: "rotated-refresh-token" });
    expect(calls[3]?.url.searchParams.get("mediaKind")).toBe("ebook");
    expect(new Headers(calls[3]?.init?.headers).get("Authorization")).toBe("Bearer access-token");
    expect(currentRefreshToken).toBe("rotated-again-token");
  });

  it("maps availability, destination, create, and status calls to BookOrbit 3.2 routes", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetcher = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push({ url, init });
      if (url.pathname.endsWith("/auth/refresh")) {
        return Response.json({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (url.pathname.endsWith("/book-requests/availability")) {
        return Response.json([{ ownedBookId: null, existingRequestId: null, existingRequestStatus: null, alreadySubscribed: false }]);
      }
      if (url.pathname.endsWith("/book-requests/default-destinations")) {
        return Response.json({ ebook: { libraryId: 3, libraryName: "E-books", folderId: 8 }, audiobook: null, comic: null });
      }
      if (url.pathname.endsWith("/book-requests") && init?.method === "POST") {
        return Response.json({ request: { id: 42, status: "pending", title: book.title, mediaKind: "ebook" }, subscribed: false });
      }
      return Response.json({ id: 42, status: "approved", title: book.title, mediaKind: "ebook" });
    }) as typeof fetch;
    const client = new BookOrbitClient({
      baseUrl: "https://books.example.test",
      getRefreshToken: () => "oidc-refresh-token",
      saveRefreshToken: () => {},
      fetcher,
    });

    const availability = await client.checkAvailability([book]);
    const destinations = await client.getDefaultDestinations();
    const created = await client.createRequest({ title: book.title, mediaKind: "ebook", preferredFormats: ["epub"] });
    const status = await client.getRequest(42);

    expect(availability[0]?.alreadySubscribed).toBe(false);
    expect(destinations.ebook?.libraryId).toBe(3);
    expect(created.request.id).toBe(42);
    expect(status.status).toBe("approved");
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      "/api/v1/auth/refresh",
      "/api/v1/book-requests/availability",
      "/api/v1/book-requests/default-destinations",
      "/api/v1/book-requests",
      "/api/v1/book-requests/42",
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ items: [{ author: "Ursula K. Le Guin", mediaKind: "ebook" }] });
  });
});

describe("BookOrbit request history", () => {
  const stores: HistoryStore[] = [];
  const directories: string[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("keeps recommendations, feedback, and one request outcome under a stable work key", () => {
    const history = new HistoryStore(":memory:");
    stores.push(history);

    history.recordBookEvent({ type: "recommendation", book, source: "nonfiction-list", eventId: "run-1-book-1" });
    history.recordBookEvent({ type: "recommendation", book, source: "nonfiction-list", eventId: "run-1-book-1" });
    history.recordBookEvent({ type: "feedback", book, feedback: "Want to read this." });

    expect(history.reserveRequest(book).reserved).toBe(true);
    expect(history.reserveRequest(book).reserved).toBe(false);
    history.saveRequestOutcome(book, {
      state: "newly_requested",
      requestId: 42,
      requestStatus: "pending",
    });

    const record = history.get(book);
    expect(record?.recommendationSources).toEqual(["nonfiction-list"]);
    expect(record?.feedback).toBe("Want to read this.");
    expect(record?.requestId).toBe(42);
    expect(record?.requestStatus).toBe("pending");
    expect(record?.events.map((event) => event.type)).toEqual(["recommendation", "feedback"]);
    expect(history.list()).toHaveLength(1);
  });

  it("uses BookOrbit's work identity rather than edition ISBN for request deduplication", () => {
    const history = new HistoryStore(":memory:");
    stores.push(history);

    history.recordBookEvent({ type: "recommendation", book });
    expect(history.reserveRequest(book).reserved).toBe(true);
    expect(
      history.reserveRequest({ ...book, isbn13: "9780000000001" }).reserved,
    ).toBe(false);
  });

  it("keeps recommendation and request history after reopening SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "bookorbit-history-test-"));
    directories.push(directory);
    const path = join(directory, "history.sqlite");
    const first = new HistoryStore(path);
    first.recordBookEvent({ type: "recommendation", book, source: "weekly-list" });
    first.reserveRequest(book);
    first.saveRequestOutcome(book, { state: "newly_requested", requestId: 7, requestStatus: "pending" });
    first.setSecret("bookorbit_refresh_token", "rotated-oidc-refresh-token");
    first.close();

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new HistoryStore(path);
    stores.push(reopened);
    expect(reopened.get(book)?.requestId).toBe(7);
    expect(reopened.get(book)?.recommendationSources).toEqual(["weekly-list"]);
    expect(reopened.getSecret("bookorbit_refresh_token")).toBe("rotated-oidc-refresh-token");
  });

  it("does not submit twice after an uncertain create response", async () => {
    const history = new HistoryStore(":memory:");
    stores.push(history);
    let createCalls = 0;
    const client = {
      checkAvailability: async () => [{
        ownedBookId: null,
        existingRequestId: null,
        existingRequestStatus: null,
        alreadySubscribed: false,
      }],
      getDefaultDestinations: async () => ({
        ebook: { libraryId: 1, libraryName: "Books", folderId: null },
        audiobook: null,
        comic: null,
      }),
      createRequest: async () => {
        createCalls += 1;
        throw new TypeError("connection reset");
      },
    } as unknown as BookOrbitClient;
    const requestBook = createRequestBookHandler(client, history, "https://books.example.test");
    const input = { book, technicalWork: false };

    const first = await requestBook(input);
    const second = await requestBook(input);

    expect(first.requestState).toBe("unknown");
    expect(second.requestState).toBe("unknown");
    expect(createCalls).toBe(1);
  });

  it("submits English requests with EPUB defaults and PDF only for technical works", async () => {
    const history = new HistoryStore(":memory:");
    stores.push(history);
    const payloads: CreateBookRequest[] = [];
    const client = {
      checkAvailability: async () => [{
        ownedBookId: null,
        existingRequestId: null,
        existingRequestStatus: null,
        alreadySubscribed: false,
      }],
      getDefaultDestinations: async () => ({
        ebook: { libraryId: 1, libraryName: "Books", folderId: 7 },
        audiobook: null,
        comic: null,
      }),
      createRequest: async (payload: CreateBookRequest) => {
        payloads.push(payload);
        return {
          request: { id: payloads.length + 40, status: "pending", title: payload.title, mediaKind: "ebook" },
          subscribed: false,
        };
      },
    } as unknown as BookOrbitClient;
    const requestBook = createRequestBookHandler(client, history, "https://books.example.test");

    const ordinary = await requestBook({ book, technicalWork: false });
    const technical = await requestBook({
      book: { title: "Field Guide to Systems", authors: ["Ada Lovelace"], mediaKind: "ebook" },
      technicalWork: true,
    });
    await requestBook({ book, technicalWork: false });

    expect(ordinary.status).toBe("newly_requested");
    expect(ordinary.requestLink).toBe("https://books.example.test/requests/41");
    expect(technical.status).toBe("newly_requested");
    expect(payloads.map((payload) => payload.preferredFormats)).toEqual([["epub"], ["epub", "pdf"]]);
    expect(payloads.every((payload) => payload.language === "en" && payload.selfServe === false)).toBe(true);
    expect(payloads.every((payload) => payload.targetLibraryId === 1 && payload.targetFolderId === 7)).toBe(true);
  });

  it("preserves an owned BookOrbit book link in idempotent results", async () => {
    const history = new HistoryStore(":memory:");
    stores.push(history);
    const client = {
      checkAvailability: async () => [{
        ownedBookId: 9,
        existingRequestId: null,
        existingRequestStatus: null,
        alreadySubscribed: false,
      }],
      createRequest: async () => { throw new Error("must not submit an owned book"); },
    } as unknown as BookOrbitClient;
    const requestBook = createRequestBookHandler(client, history, "https://books.example.test");

    const first = await requestBook({ book, technicalWork: false });
    const second = await requestBook({ book, technicalWork: false });

    expect(first.status).toBe("already_available");
    expect(first.link).toBe("https://books.example.test/book/9");
    expect(second.link).toBe(first.link);
  });
});

describe("Streamable HTTP MCP service", () => {
  it("lists and invokes adapter tools without a session", async () => {
    const fetcher = (async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/auth/refresh")) {
        return Response.json({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      return new Response(`data: ${JSON.stringify({ provider: "google", providerId: "edition-1", title: "The Dispossessed", authors: ["Ursula K. Le Guin"], isbn13: "9780061054884" })}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    const service = await startMcpService({
      baseUrl: "https://books.example.test",
      refreshToken: "oidc-refresh-token",
      historyPath: ":memory:",
      port: 0,
      fetcher,
    });

    try {
      const endpoint = `http://127.0.0.1:${service.server.port}/mcp`;
      const headers = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
      const initialize = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        }),
      });
      expect(initialize.ok).toBe(true);

      const listResponse = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      const toolList = await listResponse.json() as { result: { tools: Array<{ name: string }> } };
      expect(toolList.result.tools.map((tool) => tool.name).sort()).toEqual([
        "find_existing_books",
        "get_reading_history",
        "get_request_status",
        "record_book_event",
        "request_book",
        "search_books",
      ]);

      const search = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "search_books", arguments: { title: "The Dispossessed" } },
        }),
      });
      const searchResponse = await search.json() as { result: { structuredContent: { candidates: MetadataCandidate[] } } };
      expect(searchResponse.result.structuredContent.candidates[0]?.isbn13).toBe("9780061054884");
    } finally {
      await service.close();
    }
  });

  it("completes initialize, tools/list, and tools/call through the MCP TypeScript SDK client", async () => {
    const fetcher = (async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/auth/refresh")) {
        return Response.json({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      const candidates = [
        { provider: "itunes", providerId: "edition-anniversary", title: "Dispossessed, The [50th Anniversary Edition]", authors: ["Ursula K. Le Guin"], publishedYear: 2024 },
        { provider: "openLibrary", providerId: "edition-original", title: "The Dispossessed", authors: ["Ursula K. Le Guin"], isbn13: "9780061054884", publishedYear: 1974 },
        { provider: "itunes", providerId: "wrong-author", title: "The Dispossessed", authors: ["Szilard Borbely"], publishedYear: 2016 },
      ];
      return new Response(candidates.map((candidate) => `data: ${JSON.stringify(candidate)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    const service = await startMcpService({
      baseUrl: "https://books.example.test",
      refreshToken: "oidc-refresh-token",
      historyPath: ":memory:",
      port: 0,
      fetcher,
    });
    const client = new Client({ name: "adapter-sdk-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.server.port}/mcp`));

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("request_book");
      const result = await client.callTool({ name: "search_books", arguments: { title: "The Dispossessed", author: "Ursula K. Le Guin" } });
      expect(result.isError).not.toBe(true);
      const search = result.structuredContent as { candidates: MetadataCandidate[] };
      expect(search.candidates[0]).toMatchObject({ providerId: "edition-original", isbn13: "9780061054884" });
    } finally {
      await client.close();
      await service.close();
    }
  });
});
