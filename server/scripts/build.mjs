import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

// Everything is bundled into one file so the runtime image needs no
// node_modules. `node:sqlite` is a builtin and must stay external.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  sourcemap: true,
  minify: false,
  packages: 'bundle',
  external: ['node:*'],
  loader: { '.sql': 'text' },
  banner: {
    // Some bundled CJS deps expect these to exist in an ESM context.
    js: [
      "import { createRequire as __haroCreateRequire } from 'node:module';",
      "import { fileURLToPath as __haroFileURLToPath } from 'node:url';",
      "import { dirname as __haroDirname } from 'node:path';",
      'const require = __haroCreateRequire(import.meta.url);',
      'const __filename = __haroFileURLToPath(import.meta.url);',
      'const __dirname = __haroDirname(__filename);'
    ].join('\n')
  }
});

console.log('built server → dist/index.js');
