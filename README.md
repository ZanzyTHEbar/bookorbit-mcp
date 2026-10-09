# BookOrbit MCP Server

A Streamable HTTP MCP adapter for BookOrbit 3.2 and later. It exposes metadata search, library/request checks, request submission, request status, and durable recommendation history to MCP clients.

## Tools

| Tool | Description |
| --- | --- |
| `search_books` | Find metadata and edition candidates by title, author, publication year, or ISBN. Exact title/author/year matches rank first; ambiguous candidates remain visible. |
| `find_existing_books` | Check accessible library copies and active requests. |
| `request_book` | Request an English e-book, preferring EPUB and allowing PDF only for technical works. |
| `get_request_status` | Return a request's current state and BookOrbit link. |
| `record_book_event` | Persist a recommendation or user-feedback event. |
| `get_reading_history` | Read recommendations, feedback, request IDs, and outcomes stored by this adapter. |

Requests use a persistent work-and-medium idempotency key aligned with BookOrbit's work-level deduplication. Before submission, the adapter checks for an accessible library copy or active request. Uncertain submissions are reconciled instead of blindly retried.

## Authentication and configuration

Configure OIDC for a dedicated, non-administrator BookOrbit account with request permission and access to the destination library. Bootstrap the adapter with the native BookOrbit refresh token returned by the OIDC callback. The adapter exchanges and rotates that token through BookOrbit's refresh endpoint, storing each rotation in its private SQLite database with restrictive file permissions. Credentials are not exposed through MCP responses or logs.

| Variable | Purpose |
| --- | --- |
| `BOOKORBIT_BASE_URL` | Base URL of the BookOrbit instance. |
| `BOOKORBIT_REFRESH_TOKEN` | Initial OIDC-issued BookOrbit refresh token; needed when the history volume is empty. |
| `MCP_NETWORK_NAME` | Existing private Docker network shared with the MCP gateway. Defaults to `mcp`. |
| `HISTORY_PATH` | SQLite history path. Defaults to `/data/bookorbit-history.sqlite` in Compose. |
| `PORT` | Internal HTTP port. Defaults to `3000`. |

Keep the adapter on a private network. The MCP gateway must enforce authorization before forwarding requests to `/mcp`; do not publish port 3000 directly.

## Local development

Requires Bun 1.4+ and Docker Compose.

```sh
bun install
cp .env.example .env
# Set BOOKORBIT_BASE_URL and BOOKORBIT_REFRESH_TOKEN in the ignored .env file.
docker network create mcp
docker compose up --build -d
```

The Compose service exposes `/mcp` and `/health` internally and persists history in the `bookorbit-history` volume.

```sh
bun test
bun run typecheck
docker compose config
```

`Dockerfile` is the Compose build recipe. Deploy `docker-compose.yaml` as a Compose application.
