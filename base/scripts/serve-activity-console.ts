import { createReadStream } from "node:fs";
import { createServer } from "node:http";

const root = process.cwd();
const port = Number(process.env.BASE_ACTIVITY_PORT ?? process.env.PORT ?? "4174");
const activityConsolePath = `${root}/base/activity-console.html`;
const ethersModulePath = `${root}/node_modules/ethers/dist/ethers.min.js`;

const server = createServer((req, res) => {
  try {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const isConsolePage = pathname === "/" || pathname === "/base/activity-console.html";
    const isEthersModule = pathname === "/node_modules/ethers/dist/ethers.min.js";
    if (!isConsolePage && !isEthersModule) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": isEthersModule ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    createReadStream(isEthersModule ? ethersModulePath : activityConsolePath).pipe(res);
  } catch (error) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : "Bad request");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Base Activity Console ready at http://127.0.0.1:${port}`);
});
