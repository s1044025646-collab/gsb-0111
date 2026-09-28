import { listenOnFreePort } from './api.js';

const dbPath = process.env.SEISMIC_DB ?? './data/seismic.sqlite';
listenOnFreePort(dbPath).then(({ server, port }) => {
  console.log(`Seismic backend listening on http://127.0.0.1:${port}`);
  console.log(`Database: ${dbPath}`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
