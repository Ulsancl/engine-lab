import { defineConfig } from 'vite';
export default defineConfig({ base: './', server: { watch: { ignored: ['**/.security-stage-*', '**/.security-stage-*/**'] }, host: '127.0.0.1', port: 5196, strictPort: true }, build: { outDir: 'dist', emptyOutDir: true } });
