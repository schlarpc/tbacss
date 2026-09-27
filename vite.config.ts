import { defineConfig } from 'vite';

// The page is served from a GitHub Pages project subpath, and it fetches the
// data bundle from the relative path `data/`. Neither the bundle nor anything
// else under web/data is part of the build: it is ~640 MB, built outside CI,
// and copied in next to dist/ afterwards. In dev, vite serves web/data from the
// root like any other file.
export default defineConfig({
  root: 'web',
  base: './',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
