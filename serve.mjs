// Мини-сервер для локального тестирования расширения в AnymeX/Mangayomi.
// Запуск: node serve.mjs  →  репозиторий доступен по адресу
//   http://127.0.0.1:18365/anime_index.local.json   (на этом же ПК)
//   http://<IP-этого-ПК>:18365/anime_index.local.json (с телефона в той же сети)
import { createServer } from "http";
import { readFile } from "fs/promises";
import { join, normalize } from "path";
import { fileURLToPath } from "url";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".json": "application/json; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

createServer(async (req, res) => {
    try {
        const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^([/\\])+/, "");
        if (path.includes("..")) throw new Error("bad path");
        const file = join(root, path);
        const body = await readFile(file);
        const ext = file.slice(file.lastIndexOf("."));
        res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
        res.end(body);
        console.log("200", req.url);
    } catch {
        res.writeHead(404);
        res.end("not found");
        console.log("404", req.url);
    }
}).listen(18365, "0.0.0.0", () => {
    console.log("Репозиторий расширения: http://127.0.0.1:18365/anime_index.local.json");
});
