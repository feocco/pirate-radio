const pirateRadioOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "Pirate Radio API",
    version: "0.1.0",
    description:
      "Browser pages and JSON endpoints exposed by the Pirate Radio service for library playback, queue conversion, and health checks.",
  },
  servers: [{ url: "/" }],
  security: [{ cookieAuth: [] }],
  components: {
    securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "pirate_radio_session" },
    },
    schemas: {
      AuthenticationError: {
        type: "object",
        properties: { error: { type: "string", const: "authentication_required" } },
        required: ["error"],
      },
      AuthorizationError: {
        type: "object",
        properties: { error: { type: "string", const: "admin_required" } },
        required: ["error"],
      },
    },
  },
  tags: [
    { name: "service", description: "Operational and discovery endpoints." },
    { name: "library", description: "Library pages, media, and playback state." },
    { name: "queue", description: "Recent-feed queue views and conversion actions." },
    { name: "identity", description: "OIDC login and application session endpoints." },
  ],
  paths: {
    "/health": {
      get: {
        security: [],
        tags: ["service"],
        summary: "Service health check",
        responses: {
          "200": {
            description: "The service is healthy.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    ok: { type: "boolean", const: true },
                  },
                  required: ["ok"],
                },
              },
            },
          },
        },
      },
    },
    "/auth/login": {
      get: {
        security: [],
        tags: ["identity"],
        summary: "Start authorization-code OIDC login with PKCE",
        responses: { "302": { description: "Redirect to Authentik." } },
      },
    },
    "/auth/callback": {
      get: {
        security: [],
        tags: ["identity"],
        summary: "Consume a one-time OIDC callback",
        responses: {
          "302": { description: "Session created and redirected to the requested local page." },
          "400": { description: "Expired, replayed, or invalid callback." },
          "403": { description: "The identity lacks pirate-radio-users membership." },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["identity"],
        summary: "Current application identity and role snapshot",
        responses: { "200": { description: "Current authenticated user." }, "401": { description: "No valid session." } },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["identity"],
        summary: "Revoke the opaque session and continue through provider logout",
        responses: { "303": { description: "Session revoked; redirect to Authentik end-session." }, "403": { description: "Origin did not match the public service URL." } },
      },
    },
    "/docs": {
      get: {
        tags: ["service"],
        summary: "Human-readable service docs",
        responses: {
          "200": {
            description: "An HTML summary of the public Pirate Radio routes.",
            content: {
              "text/html": {
                schema: { type: "string" },
              },
            },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["service"],
        summary: "OpenAPI document",
        responses: {
          "200": {
            description: "OpenAPI 3.1 JSON for the public Pirate Radio routes.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    openapi: { type: "string" },
                    info: { type: "object" },
                    paths: { type: "object" },
                  },
                  required: ["openapi", "info", "paths"],
                },
              },
            },
          },
        },
      },
    },
    "/": {
      get: {
        tags: ["library"],
        summary: "Library reader page",
        responses: {
          "200": {
            description: "HTML audio library UI.",
            content: { "text/html": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/admin": {
      get: {
        tags: ["service"],
        summary: "Admin page",
        responses: {
          "200": {
            description: "HTML admin page with service quick links.",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "403": { description: "Authenticated member is not in pirate-radio-admins." },
        },
      },
    },
    "/library.json": {
      get: {
        tags: ["library"],
        summary: "Library manifest",
        responses: {
          "200": {
            description: "Converted library items excluding voice-filtered content.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { type: "object" },
                },
              },
            },
          },
        },
      },
    },
    "/article/{slug}": {
      get: {
        tags: ["library"],
        summary: "Article reader page",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "HTML article page with audio playback and story text.",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "404": {
            description: "The article is not present in the library manifest.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string", const: "article_not_found" } },
                  required: ["error"],
                },
              },
            },
          },
        },
      },
    },
    "/admin/articles/{slug}/delete": {
      post: {
        tags: ["library"],
        summary: "Archive and remove an article from the active library",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "303": { description: "Article archived and redirected to the library." },
          "403": { description: "The caller is not an administrator or the Origin is invalid." },
          "404": { description: "The article is not present in the library manifest." },
        },
      },
    },
    "/progress/{slug}": {
      get: {
        tags: ["library"],
        summary: "Read saved playback progress",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Saved playback progress for an article.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    slug: { type: "string" },
                    positionSeconds: { type: "number" },
                    durationSeconds: { type: "number" },
                    updatedAt: { type: "string", format: "date-time" },
                    completedAt: { type: "string", format: "date-time" },
                  },
                  required: ["slug", "positionSeconds", "updatedAt"],
                },
              },
            },
          },
          "404": {
            description: "No saved progress exists for the requested article.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string", const: "progress_not_found" } },
                  required: ["error"],
                },
              },
            },
          },
        },
      },
      put: {
        tags: ["library"],
        summary: "Write playback progress",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  positionSeconds: { type: "number" },
                  durationSeconds: { type: "number" },
                  ended: { type: "boolean", description: "Browser emitted the ended event." },
                },
                required: ["positionSeconds"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated playback progress.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    slug: { type: "string" },
                    positionSeconds: { type: "number" },
                    durationSeconds: { type: "number" },
                    updatedAt: { type: "string", format: "date-time" },
                    completedAt: { type: "string", format: "date-time" },
                  },
                  required: ["slug", "positionSeconds", "updatedAt"],
                },
              },
            },
          },
          "400": {
            description: "The JSON body could not be parsed into playback progress.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string", const: "bad_progress" } },
                  required: ["error"],
                },
              },
            },
          },
        },
      },
    },
    "/queue": {
      get: {
        tags: ["queue"],
        summary: "Queue browser page",
        responses: {
          "200": {
            description: "HTML queue page for recent feed items.",
            content: { "text/html": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/queue.json": {
      get: {
        tags: ["queue"],
        summary: "Queue feed snapshot",
        responses: {
          "200": {
            description: "Recent RSS items annotated with conversion status.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    version: { type: "integer" },
                    updatedAt: { type: "string", format: "date-time" },
                    items: {
                      type: "array",
                      items: { type: "object" },
                    },
                  },
                  required: ["version", "updatedAt", "items"],
                },
              },
            },
          },
        },
      },
    },
    "/submissions.json": {
      get: {
        tags: ["queue"],
        summary: "Recent global submission history with attribution and status",
        responses: {
          "200": {
            description: "Authenticated submission history.",
            content: { "application/json": { schema: { type: "object", properties: { version: { type: "integer" }, items: { type: "array", items: { type: "object" } } }, required: ["version", "items"] } } },
          },
          "401": { description: "No valid application session." },
        },
      },
    },
    "/queue/convert/{slug}": {
      post: {
        tags: ["queue"],
        summary: "Queue conversion for a recent feed item",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "The article is queued, already converted, or already processing.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    status: { type: "string" },
                  },
                  required: ["ok", "status"],
                },
              },
            },
          },
          "404": {
            description: "The slug does not map to a queue article.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", const: false },
                    status: { type: "string", const: "missing" },
                  },
                  required: ["ok", "status"],
                },
              },
            },
          },
        },
      },
    },
    "/queue/convert-url": {
      post: {
        tags: ["queue"],
        summary: "Queue conversion for a pasted Pirate Wires, Substack, X Article, or WSJ URL",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  url: { type: "string", format: "uri" },
                },
                required: ["url"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The pasted URL was accepted and queued.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", const: true },
                    status: { type: "string" },
                    slug: { type: "string" },
                  },
                  required: ["ok", "status", "slug"],
                },
              },
            },
          },
          "400": {
            description: "The pasted URL is invalid or not a supported article URL.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    status: { type: "string" },
                    error: { type: "string" },
                  },
                  required: ["ok", "status", "error"],
                },
              },
            },
          },
        },
      },
    },
    "/queue/convert-text": {
      post: {
        tags: ["queue"],
        summary: "Queue conversion for pasted custom text",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", maxLength: 160 },
                  text: { type: "string", maxLength: 60000 },
                },
                required: ["title", "text"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The pasted text was accepted and queued.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", const: true },
                    status: { type: "string", const: "queued" },
                  },
                  required: ["ok", "status"],
                },
              },
            },
          },
          "400": {
            description: "The pasted text is missing, too large, or otherwise invalid.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", const: false },
                    status: { type: "string", const: "invalid_text" },
                    error: { type: "string" },
                  },
                  required: ["ok", "status", "error"],
                },
              },
            },
          },
        },
      },
    },
    "/vendor/shikwasa/shikwasa.iife.js": {
      get: {
        tags: ["library"],
        summary: "Serve the authenticated Shikwasa player script",
        responses: {
          "200": {
            description: "Pinned Shikwasa IIFE build.",
            content: { "text/javascript": { schema: { type: "string" } } },
          },
          "401": {
            description: "Missing application session.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/vendor/shikwasa/style.css": {
      get: {
        tags: ["library"],
        summary: "Serve the authenticated Shikwasa stylesheet",
        responses: {
          "200": {
            description: "Pinned Shikwasa stylesheet.",
            content: { "text/css": { schema: { type: "string" } } },
          },
          "401": {
            description: "Missing application session.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/audio/{filename}": {
      get: {
        tags: ["library"],
        summary: "Stream generated MP3 audio",
        parameters: [
          {
            name: "filename",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "The full MP3 file.",
            content: { "audio/mpeg": { schema: { type: "string", format: "binary" } } },
          },
          "206": {
            description: "A byte range from the MP3 file.",
            content: { "audio/mpeg": { schema: { type: "string", format: "binary" } } },
          },
          "404": {
            description: "The audio file does not exist.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
      head: {
        tags: ["library"],
        summary: "Read audio headers and optional byte-range metadata",
        parameters: [
          {
            name: "filename",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Audio headers for the full file." },
          "206": { description: "Audio headers for a byte range." },
        },
      },
    },
    "/images/{filename}": {
      get: {
        tags: ["library"],
        summary: "Read cached article art",
        parameters: [
          {
            name: "filename",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "The cached image file.",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
              "image/jpeg": { schema: { type: "string", format: "binary" } },
              "image/webp": { schema: { type: "string", format: "binary" } },
            },
          },
        },
      },
    },
    "/alignment/{filename}": {
      get: {
        tags: ["library"],
        summary: "Read optional word-alignment metadata",
        parameters: [
          {
            name: "filename",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Alignment JSON generated when word-level highlighting is enabled.",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    },
  },
} as const;

type EndpointDoc = {
  method: string;
  path: string;
  description: string;
};

const endpointDocs: EndpointDoc[] = [
  { method: "GET", path: "/health", description: "Health probe used for service monitoring." },
  { method: "GET", path: "/docs", description: "This HTML summary of the public service contract." },
  { method: "GET", path: "/openapi.json", description: "OpenAPI 3.1 JSON for machine-readable route details." },
  { method: "GET", path: "/", description: "Main audio library page for converted articles." },
  { method: "GET", path: "/admin", description: "Admin quick-links page for operator checks." },
  { method: "GET", path: "/library.json", description: "Library manifest consumed by the reader UI." },
  { method: "GET", path: "/article/{slug}", description: "Dedicated article page with audio and story text." },
  { method: "POST", path: "/admin/articles/{slug}/delete", description: "Admin-only recoverable article deletion." },
  { method: "GET", path: "/progress/{slug}", description: "Read saved playback position for one article." },
  { method: "PUT", path: "/progress/{slug}", description: "Persist playback position for one article." },
  { method: "GET", path: "/queue", description: "Queue browser for recent RSS articles." },
  { method: "GET", path: "/queue.json", description: "Recent RSS items annotated with conversion status." },
  { method: "POST", path: "/queue/convert/{slug}", description: "Queue conversion for a feed-backed queue article." },
  { method: "POST", path: "/queue/convert-url", description: "Queue conversion for a pasted article URL." },
  { method: "POST", path: "/queue/convert-text", description: "Queue conversion for pasted custom text." },
  { method: "GET, HEAD", path: "/audio/{filename}", description: "Serve generated MP3 audio with range support." },
  { method: "GET", path: "/images/{filename}", description: "Serve cached article art from the local library." },
  { method: "GET", path: "/alignment/{filename}", description: "Serve optional word-alignment JSON when available." },
  { method: "GET", path: "/vendor/shikwasa/shikwasa.iife.js", description: "Authenticated Shikwasa player script." },
  { method: "GET", path: "/vendor/shikwasa/style.css", description: "Authenticated Shikwasa stylesheet." },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function getPirateRadioOpenApiDocument(): unknown {
  return pirateRadioOpenApi;
}

export function renderPirateRadioDocsHtml(): string {
  const rows = endpointDocs
    .map(
      ({ method, path, description }) => `
        <tr>
          <td><code>${escapeHtml(method)}</code></td>
          <td><code>${escapeHtml(path)}</code></td>
          <td>${escapeHtml(description)}</td>
        </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pirate Radio API Docs</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, system-ui, sans-serif;
      }
      body {
        margin: 0;
        background: #0b1020;
        color: #e5edf8;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1, h2, p {
        margin-top: 0;
      }
      .lede {
        color: #bfd0ec;
        max-width: 760px;
      }
      a {
        color: #8fc2ff;
      }
      .panel {
        background: rgba(12, 18, 34, 0.9);
        border: 1px solid rgba(143, 194, 255, 0.18);
        border-radius: 8px;
        padding: 20px;
        margin-top: 20px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-top: 1px solid rgba(191, 208, 236, 0.16);
        vertical-align: top;
      }
      th {
        border-top: 0;
        color: #8fc2ff;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Pirate Radio API Docs</h1>
      <p class="lede">
        Pirate Radio exposes a small browser-first HTTP surface for the audio library, recent queue,
        playback progress, and service health. The machine-readable contract lives at
        <a href="/openapi.json">/openapi.json</a>.
      </p>
      <section class="panel">
        <h2>Endpoints</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Path</th>
              <th scope="col">Purpose</th>
            </tr>
          </thead>
          <tbody>${rows}
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}
