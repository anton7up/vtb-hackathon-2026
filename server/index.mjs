import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase } from './database.mjs';
import { createAppServer } from './http.mjs';
import { createInspector } from './scanner/service.mjs';
import { createCbrWarningService } from './cbr-warning-service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let portText = process.env.PORT || '3000';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) portText = args[++i];
  else throw new Error('Usage: npm start -- --port 3000');
}
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.PUBLIC_ORIGIN) throw new Error('Non-loopback HOST requires an explicit PUBLIC_ORIGIN. See docs/local-server.md');
const databasePath = resolve(root, process.env.DATABASE_PATH || 'data/antiscam.sqlite');
const db = openDatabase(databasePath);
const inspector = createInspector({ loader: process.env.SCANNER_LOADER || 'browser', dns: process.env.SCANNER_DNS || 'cloudflare', executablePath: process.env.SCANNER_BROWSER_PATH });
const server = createAppServer({ db, runtime: {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_API_URL: process.env.GROQ_API_URL,
  GROQ_RELAY_TOKEN: process.env.GROQ_RELAY_TOKEN,
  inspectWebsite: inspector,
  cbrWarning: createCbrWarningService(),
}, publicOrigin: process.env.PUBLIC_ORIGIN });
server.once('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose --port.` : 'Cannot start local server'); db.close(); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log(`АнтиСкам: http://${host === '::1' ? '[::1]' : host}:${port}`);
  console.log('SQLite ready. Local mode; no Cloudflare or Sites connection. Stop: Ctrl+C.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => { db.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5000).unref();
});
