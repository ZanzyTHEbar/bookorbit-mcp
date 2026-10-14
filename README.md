# BookOrbit MCP Server

A Streamable HTTP MCP adapter for BookOrbit 3.2 and later. It exposes metadata search, library/request checks, request submission, request status, and durable recommendation history to MCP clients.

## Tools

| Tool | Description |
| --- | --- |
| `search_books` | Find metadata and edition candidates by title, author, publication year, or ISBN. Exact matches rank first; ambiguous candidates and provider failures are reported. |
| `browse_library` | Browse accessible library books without a search query, page by page. |
| `find_existing_books` | Check accessible library copies and active requests. |
| `request_book` | Request an English e-book, preferring EPUB and allowing PDF only for technical works. |
| `get_request_status` | Return a request's current state and BookOrbit link. |
| `list_smart_scopes` | List visible Smart Scopes, IDs, filters, ownership, and matching counts. |
| `update_smart_scope` | Update supplied fields on an owned Smart Scope by ID. |
| `delete_smart_scope` | Delete an owned Smart Scope by ID after matching its current name. |
| `create_smart_scope` | Create a Smart Scope using BookOrbit's native filter and sort fields. |
| `list_collections` | List visible Collections with IDs, ownership, media type, and member counts. |
| `create_collection` | Create a standard book Collection, private by default. |
| `add_tags_to_books` | Add tags to existing library books by BookOrbit book ID; existing tags are preserved. |
| `remove_tags_from_books` | Remove specified tags from existing books. BookOrbit may write metadata or rename files. |
| `add_books_to_collection` | Add existing library books by ID to an owned Collection. |
| `record_book_event` | Persist a recommendation or user-feedback event. |
| `get_reading_history` | Read recommendations, feedback, request IDs, and outcomes stored by this adapter. |

Requests use a persistent work-and-medium idempotency key aligned with BookOrbit's work-level deduplication. Before submission, the adapter checks for an accessible library copy or active request. Uncertain submissions are reconciled instead of blindly retried.

## Authentication and configuration

Configure OIDC for a dedicated, non-administrator BookOrbit account with request permission and access to the destination library. Grant the account BookOrbit's library metadata-edit permission to use the tag tools. Tag changes may trigger BookOrbit metadata writes or file renames. Smart Scopes and Collections are created or populated as the authenticated account; these tools do not elevate permissions. Bootstrap the adapter with the native BookOrbit refresh token returned by the OIDC callback. The adapter exchanges and rotates that token through BookOrbit's refresh endpoint, storing each rotation in its private SQLite database with restrictive file permissions. Credentials are not exposed through MCP responses or logs.

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

## Releases

Pushes to `main` are released with semantic-release using Conventional Commits: breaking changes bump major, `feat` and `docs` bump minor, and `fix`, `perf`, `revert`, `style`, `refactor`, `test`, `build`, and `ci` commits with a `ci-*` scope bump patch. `chore` commits do not release. Each release updates `package.json` and `CHANGELOG.md`, creates a `vX.Y.Z` tag and GitHub Release, and keeps the package private from npm publishing.
