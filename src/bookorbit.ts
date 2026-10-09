export type MediaKind = "ebook" | "audiobook" | "comic";

export interface BookIdentity {
  title: string;
  authors?: string[];
  isbn10?: string;
  isbn13?: string;
  providerKey?: string;
  providerId?: string;
  mediaKind: MediaKind;
}

export interface MetadataCandidate {
  provider: string;
  providerId: string;
  title?: string;
  authors?: string[];
  isbn10?: string;
  isbn13?: string;
  mediaKind?: MediaKind;
  subtitle?: string;
  seriesName?: string;
  seriesIndex?: number | string;
  publishedYear?: number;
  language?: string;
  coverUrl?: string;
  sourceUrl?: string;
}

export interface ProviderSearchStatus {
  provider: string;
  outcome: "timeout" | "throttled" | "failed";
}

export interface MetadataSearchResult {
  candidates: MetadataCandidate[];
  providerStatuses: ProviderSearchStatus[];
}

export type AvailabilityItem = BookIdentity;

export interface BookRequestAvailability {
  ownedBookId: number | null;
  existingRequestId: number | null;
  existingRequestStatus: string | null;
  alreadySubscribed: boolean;
}

export interface DefaultDestination {
  libraryId: number;
  libraryName: string | null;
  folderId: number | null;
}

export type DefaultDestinations = Record<MediaKind, DefaultDestination | null>;

export interface CreateBookRequest {
  title: string;
  mediaKind: MediaKind;
  subtitle?: string;
  authors?: string[];
  seriesName?: string;
  seriesIndex?: number;
  isbn10?: string;
  isbn13?: string;
  publishedYear?: number;
  language?: string;
  coverUrl?: string;
  providerKey?: string;
  providerId?: string;
  metadataSources?: Array<{
    providerKey: string;
    providerId: string;
    providerLabel: string;
    isbn10?: string | null;
    isbn13?: string | null;
  }>;
  preferredFormats: string[];
  note?: string;
  targetLibraryId?: number;
  targetFolderId?: number;
  selfServe?: false;
}

export interface BookRequestItem {
  id: number;
  status: string;
  title: string;
  mediaKind: MediaKind;
  [key: string]: unknown;
}

export interface BookRequestSubmitResult {
  request: BookRequestItem;
  subscribed: boolean;
}

export class BookOrbitApiError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
  ) {
    super(`BookOrbit ${route} returned HTTP ${status}`);
    this.name = "BookOrbitApiError";
  }
}

export async function parseMetadataSse(stream: ReadableStream<Uint8Array>): Promise<MetadataSearchResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const result: MetadataSearchResult = { candidates: [], providerStatuses: [] };
  let buffer = "";
  let eventName = "message";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) {
      const value: unknown = JSON.parse(data.join("\n"));
      if (eventName === "provider-status") {
        const status = value as ProviderSearchStatus;
        if (status.provider && status.outcome) result.providerStatuses.push(status);
      } else {
        result.candidates.push(value as MetadataCandidate);
      }
    }
    eventName = "message";
    data = [];
  };

  const processLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    if (field === "data") data.push(value);
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line.replace(/\r$/, ""));
    if (done) break;
  }
  if (buffer) processLine(buffer.replace(/\r$/, ""));
  dispatch();
  return result;
}

interface NativeCredentials {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

export interface BookOrbitClientOptions {
  baseUrl: string;
  getRefreshToken: () => string | null;
  saveRefreshToken: (refreshToken: string) => void;
  fetcher?: typeof fetch;
}

export class BookOrbitClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;
  private authentication: Promise<void> | undefined;

  constructor(private readonly options: BookOrbitClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new Error("BOOKORBIT_BASE_URL must use HTTP or HTTPS");
    }
    this.baseUrl.search = "";
    this.baseUrl.hash = "";
    this.fetcher = options.fetcher ?? fetch;
  }

  async searchBooks(query: { title?: string; author?: string; isbn?: string; mediaKind: MediaKind }): Promise<MetadataSearchResult> {
    const url = this.apiUrl("metadata-fetch/stream");
    if (query.title) url.searchParams.set("title", query.title);
    if (query.author) url.searchParams.set("author", query.author);
    if (query.isbn) url.searchParams.set("isbn", query.isbn);
    url.searchParams.set("mediaKind", query.mediaKind);

    const response = await this.apiFetch(url, { headers: { Accept: "text/event-stream" } });
    if (!response.body) throw new Error("BookOrbit metadata search returned no stream");
    const result = await parseMetadataSse(response.body);
    return { ...result, candidates: result.candidates.map((candidate) => ({ ...candidate, mediaKind: query.mediaKind })) };
  }

  async checkAvailability(items: AvailabilityItem[]): Promise<BookRequestAvailability[]> {
    return this.json<BookRequestAvailability[]>("book-requests/availability", {
      method: "POST",
      body: JSON.stringify({ items: items.map((item) => ({
        title: item.title,
        mediaKind: item.mediaKind,
        author: item.authors?.[0],
        isbn13: item.isbn13,
        providerKey: item.providerKey,
        providerId: item.providerId,
      })) }),
    });
  }

  getDefaultDestinations(): Promise<DefaultDestinations> {
    return this.json<DefaultDestinations>("book-requests/default-destinations");
  }

  createRequest(payload: CreateBookRequest): Promise<BookRequestSubmitResult> {
    return this.json<BookRequestSubmitResult>("book-requests", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  getRequest(id: number): Promise<BookRequestItem> {
    return this.json<BookRequestItem>(`book-requests/${id}`);
  }

  private apiUrl(path: string): URL {
    return new URL(`/api/v1/${path}`, this.baseUrl);
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.apiFetch(this.apiUrl(path), {
      ...init,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...init.headers },
    });
    return (await response.json()) as T;
  }

  private async apiFetch(url: URL, init: RequestInit): Promise<Response> {
    const send = async () => {
      const token = await this.getAccessToken();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return this.fetcher(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) });
    };

    let response = await send();
    if (response.status === 401) {
      this.accessTokenExpiresAt = 0;
      await this.authenticate();
      response = await send();
    }
    if (!response.ok) throw new BookOrbitApiError(response.status, url.pathname.replace("/api/v1/", ""));
    return response;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() + 30_000 < this.accessTokenExpiresAt) return this.accessToken;
    await this.authenticate();
    if (!this.accessToken) throw new Error("BookOrbit authentication returned no access token");
    return this.accessToken;
  }

  private async authenticate(): Promise<void> {
    if (this.authentication) return this.authentication;
    this.authentication = this.authenticateOnce();
    try {
      await this.authentication;
    } finally {
      this.authentication = undefined;
    }
  }

  private async authenticateOnce(): Promise<void> {
    const refreshToken = this.options.getRefreshToken();
    if (!refreshToken) throw new Error("BookOrbit OIDC refresh token is not provisioned");
    const response = await this.fetcher(this.apiUrl("auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new BookOrbitApiError(response.status, "auth/refresh");
    this.saveCredentials((await response.json()) as NativeCredentials);
  }

  private saveCredentials(credentials: NativeCredentials): void {
    if (!credentials.accessToken || !credentials.refreshToken) {
      throw new Error("BookOrbit OIDC refresh returned incomplete credentials");
    }
    this.accessToken = credentials.accessToken;
    this.options.saveRefreshToken(credentials.refreshToken);
    const expiry = Date.parse(credentials.accessTokenExpiresAt);
    this.accessTokenExpiresAt = Number.isFinite(expiry) ? expiry : Date.now() + 60_000;
  }
}
