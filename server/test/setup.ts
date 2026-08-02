import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts reads process.env at import time, so these have to be in place
// before any module under test is loaded.
const scratch = mkdtempSync(join(tmpdir(), 'haro-test-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = join(scratch, 'config');
process.env.DOWNLOAD_ROOT = join(scratch, 'downloads');
process.env.LIBRARY_ROOT = join(scratch, 'library');
// Deliberately different from DOWNLOAD_ROOT so path-mapping is exercised
// rather than accidentally passing as a no-op.
process.env.QB_DOWNLOAD_ROOT = '/downloads/complete';
process.env.QBITTORRENT_PASSWORD = 'test';
process.env.JELLYFIN_API_KEY = 'test';

export const SCRATCH = scratch;
