import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const root = process.cwd();
const port = Number(process.env.BASE_ACTIVITY_PORT ?? process.env.PORT ?? "4174");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function resolvePath(urlPath: string): string {
  const safePath = decodeURIComponent(urlPath.split("?")[0] ?? "/").replace(/^\/+/, "");
  const requested = safePath === "" ? "base/activity-console.html" : safePath;
  const resolved = path.resolve(root, requested);
  if (!resolved.startsWith(root)) {
    throw new Error("Invalid path");
  }

  return resolved;
}

const server = createServer((req, res) => {
  try {
    const filePath = resolvePath(req.url ?? "/");
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : "Bad request");
  }
});

server.listen(port, () => {
  console.log(`Base Activity Console ready at http://localhost:${port}`);
});
