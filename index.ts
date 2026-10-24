import app from './src/app';
import config from './src/config/config';

const PORT = config.port;

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch: app.fetch,
  // Bun's 10s default kills stream-proxy responses, which are long-lived by
  // nature (a provider fragment can take seconds, and extract chains several).
  idleTimeout: 0,
});

console.log(`Server running at http://0.0.0.0:${PORT}`);

// Routes load their controllers on first use, which keeps cheerio out of boot. Once we are
// listening, warm it here so the first scraping request does not pay for the parse itself.
// Never do this in api/index.ts: a serverless instance is frozen once the response ends.
void import('cheerio').catch(() => {});
