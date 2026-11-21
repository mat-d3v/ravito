import { defineConfig } from 'vitest/config';

// `base` correspond au nom du dépôt pour GitHub Pages.
export default defineConfig({
  base: '/ravito/',
  test: { environment: 'node' },
});
