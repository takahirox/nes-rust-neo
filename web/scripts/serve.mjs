import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.NES_WEB_PORT || 4173);
const prefix = '/nes-rust-neo/';
const dist = new URL('../dist/', import.meta.url);
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
};
createServer(async (request, response) => {
  const path = new URL(request.url, `http://${host}`).pathname;
  const file = path === prefix ? 'index.html' : path.slice(prefix.length);
  if (!path.startsWith(prefix) || !/^[a-z_-]+\.(html|css|js|wasm)$/.test(file)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(new URL(file, dist));
    response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, host, () => console.log(`http://${host}:${port}${prefix}`));
