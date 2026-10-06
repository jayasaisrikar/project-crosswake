import type { NextConfig } from 'next';
import { resolve } from 'node:path';
const config: NextConfig = {
  turbopack: { root: resolve('../..') },
  poweredByHeader: false,
};
export default config;
