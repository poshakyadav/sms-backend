// src/test/setup.ts
import { beforeAll, afterAll } from 'vitest';
import { getTestDB } from './test-db.js';
import { getCommonDB } from '../db/common-client.js';
import type { Env } from '../types/common-types';

// Mock env for tests
const testEnv: Env['Bindings'] = {
  COMMON_TURSO_DATABASE_URL: process.env.COMMON_TURSO_DATABASE_URL!,
  COMMON_TURSO_AUTH_TOKEN: process.env.COMMON_TURSO_AUTH_TOKEN!,
  TEST_TURSO_DATABASE_URL: process.env.TEST_TURSO_DATABASE_URL!,
  TEST_TURSO_AUTH_TOKEN: process.env.TEST_TURSO_AUTH_TOKEN!,
  JWT_SECRET: 'test-secret',
  // ... add other env vars you need
} as any;

beforeAll(async () => {
  console.log('🧪 Test environment initialized');
  // You can run any global setup here (e.g. truncate test tables)
});

afterAll(async () => {
  console.log('🧹 Test environment cleaned up');
});