import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'cobertura', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/types.ts', 'src/**/*.d.ts', 'src/index.ts', 'src/logger.ts'],
      // A floor just under today's numbers: CI fails if coverage slips. Raise it as tests grow.
      thresholds: { statements: 75, branches: 57, functions: 70, lines: 75 },
    },
  },
});
