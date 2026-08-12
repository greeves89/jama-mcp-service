import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Recharts ist mit Abstand der groesste Brocken und wird nur auf zwei
        // Seiten gebraucht — als eigenes Buendel laedt der Rest schneller.
        manualChunks: { charts: ['recharts'], vendor: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
  server: {
    port: 5173,
    // Im Entwicklungsbetrieb laeuft das Backend separat; Cookies und API-Pfade
    // muessen trotzdem gleicher Herkunft erscheinen.
    proxy: { '/admin/api': 'http://localhost:8080' },
  },
});
