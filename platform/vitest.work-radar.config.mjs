export default {
  test: {
    environment: 'node',
    include: [
      'test/work-radar.test.ts',
      'test/work-radar-route.test.ts',
      'test/work-radar-data.test.ts',
      'test/work-radar-integration.test.ts',
    ],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
};
