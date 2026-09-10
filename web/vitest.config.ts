import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Nothing here touches the DOM: these are the pure helpers behind the UI,
    // which are the ones that fail quietly rather than visibly.
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
