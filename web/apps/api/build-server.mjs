import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/server.js',
  external: [
    // native node modules that shouldn't be bundled
    '@hono/node-server',
  ],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
})

console.log('✅ API server bundled → dist/server.js')
