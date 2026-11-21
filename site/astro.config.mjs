import { defineConfig } from 'astro/config';

export default defineConfig({
  base: '/demos/pr-gate-firm',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
