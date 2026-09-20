import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { createApiHandler } from './server/api.ts';
import { openDatabase } from './server/db/repository.ts';
import { seedDemoDatabase } from './server/lib/seed.ts';

const rootDirectory = fileURLToPath(new URL('.', import.meta.url));
const databasePath = process.env.PLAN_DIFF_DB ?? `${rootDirectory}data/demo.sqlite`;
const database = openDatabase(databasePath);
seedDemoDatabase(database, `${rootDirectory}test/fixtures`);
const apiHandler = createApiHandler(database);

const offlineApiPlugin: Plugin = {
  name: 'offline-sql-plan-api',
  configureServer(server: ViteDevServer) {
    server.middlewares.use((request, response, next) => {
      void apiHandler(request, response, next);
    });
  }
};

export default defineConfig({
  plugins: [react(), offlineApiPlugin],
  server: { host: '127.0.0.1', port: 5345, strictPort: true }
});
