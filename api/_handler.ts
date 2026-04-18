import { createApp } from '../server';

const appPromise = createApp({ includeFrontend: false });

export default async function handler(req: any, res: any) {
  try {
    const app = await appPromise;
    return app(req, res);
  } catch (error: any) {
    console.error('Failed to initialize API app:', error);
    return res.status(500).json({
      error: 'Failed to initialize API app',
      details: error?.message || 'Unknown initialization error'
    });
  }
}
