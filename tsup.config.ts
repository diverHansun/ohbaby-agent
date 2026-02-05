import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    target: 'node20',
    outDir: 'dist',
    treeshake: true,
    minify: false,
    shims: true,
    external: [
        // Node.js built-ins
        'fs',
        'path',
        'os',
        'child_process',
        'readline',
        'stream',
        'util',
        'events',
        'crypto',
        'http',
        'https',
        'url',
        'net',
        'tls',
        'zlib',
    ],
    esbuildOptions(options) {
        options.alias = {
            '@': './src',
        };
    },
});
