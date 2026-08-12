import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Die Tests kommen ohne Datenbank aus: alles, was sie pruefen, ist reine
    // Logik oder laeuft gegen einen fetch-Doppelgaenger. Damit laufen sie in
    // jeder Umgebung und in jedem CI-Lauf.
    globals: false,
  },
});
