import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://aipms:dengyouming2tll@132.232.166.40:15432/aipms?sslmode=disable',
  },
  verbose: true,
  strict: true,
});
