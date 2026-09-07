import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'templates/nextjs-agent/**/*.test.ts'],
    environment: 'node',
  },
});
