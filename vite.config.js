import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: 'public_static',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Hashed filenames are half of always-load-newest; the Worker's no-store on HTML is the other half.
    rollupOptions: { output: { entryFileNames: 'a/[name].[hash].js', chunkFileNames: 'a/[name].[hash].js', assetFileNames: 'a/[name].[hash][extname]' } },
  },
});
