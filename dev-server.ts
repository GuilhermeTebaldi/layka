import 'dotenv/config';
import { createApp } from './server';

async function startServer() {
  const app = await createApp({ includeFrontend: true });
  const port = Number(process.env.PORT) || 3000;

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
