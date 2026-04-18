<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/9d390fae-7da7-4ce3-b165-afc2499989a7

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Production (Frontend + API)

If you deploy only the frontend (for example on Vercel), `/api/*` will return `404` unless you configure an API backend URL.

Set `VITE_API_BASE_URL` in your frontend environment:

```
VITE_API_BASE_URL=https://your-api-domain.com
```

You can also create a `.env.production` file for Vite production builds with this value. Keep `.env.production` out of source control.

Examples:
- frontend: `https://www.laikazero.com`
- backend API: `https://api.laikazero.com`

Then the frontend will call:
- `https://api.laikazero.com/api/deals`
- `https://api.laikazero.com/api/airports/search`
- `https://api.laikazero.com/api/airports/nearby`

If you use Cloudflare with Vercel, keep DNS records as **DNS only** (no proxy) for domains pointing to Vercel.
