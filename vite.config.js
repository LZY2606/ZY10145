import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiMiddleware } from './server/api.js';
import { openDatabase } from './server/db.js';

const db = openDatabase(process.env.PLAN_DIFF_DB);

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'offline-plan-api',
      configureServer(server) {
        server.middlewares.use('/api', createApiMiddleware(db));
      },
      configurePreviewServer(server) {
        server.middlewares.use('/api', createApiMiddleware(db));
      }
    }
  ],
  publicDir: 'fixtures',
  test: {
    environment: 'node',
    include: ['test/**/*.test.js']
  }
});
