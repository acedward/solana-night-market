// No `eval` in this page (AA 00047 P9.S, deploy/RUNBOOK.md section 16): zod compiles object schemas
// with `new Function` unless told not to, and probes for it when a schema is CREATED, at module load.
// A Content-Security-Policy without 'unsafe-eval' reports that probe. This module turns zod's JIT off;
// main.tsx imports it before anything that defines a schema.

import { z } from 'zod';

z.config({ jitless: true });
