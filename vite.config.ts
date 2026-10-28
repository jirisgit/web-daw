import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { Server } from 'node:http';
import { attachSync, lanAddresses } from './server/syncServer';

/** Runs the collaboration server inside Vite, so `npm run dev` is all you need. */
function collab(): Plugin {
  const lan = (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(s: string): void }) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ addresses: lanAddresses() }));
  };
  return {
    name: 'web-daw-collab',
    configureServer(server) {
      if (server.httpServer) attachSync(server.httpServer as Server);
      server.middlewares.use('/api/lan', lan);
    },
    configurePreviewServer(server) {
      attachSync(server.httpServer as Server);
      server.middlewares.use('/api/lan', lan);
    },
  };
}

export default defineConfig({
  plugins: [react(), collab()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
