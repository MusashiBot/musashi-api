# Frontend Setup Instructions

## Quick Start Guide

### Step 1: Install Frontend Dependencies

```bash
cd frontend
pnpm install
```

### Step 2: Start the API Server (in a separate terminal)

```bash
# From the root directory
pnpm dev
```

The API server will be running on `http://127.0.0.1:3000`

### Step 3: Start the Frontend (in another terminal)

```bash
# From the frontend directory
pnpm dev
```

Or from the root:

```bash
pnpm frontend:dev
```

The frontend will open on `http://localhost:5173`

### Step 4: View the Dashboard

Once both are running, navigate to:
```
http://localhost:5173
```

## What You'll See

The Musashi dashboard displays:

1. **Header**
   - Project branding (Musashi logo)
   - Current time
   - Dark/light mode toggle

2. **System Status Panel**
   - Overall health status (healthy/degraded/down)
   - Polymarket market count
   - Kalshi market count
   - API response time

3. **Quick Stats**
   - Total markets from both platforms
   - Number of active arbitrage opportunities
   - Last update timestamps

4. **Markets Grid**
   - Top 5 markets from Polymarket and Kalshi
   - YES/NO pricing for each market
   - 24-hour trading volume
   - Category and platform badges

5. **Arbitrage Opportunities**
   - Cross-platform spreads
   - Profit potential percentages
   - Direction (which way to trade)
   - Confidence scores

6. **Text Analyzer**
   - Input field for tweets, news, or market claims
   - Analyzes for market relevance
   - Returns matching markets and urgency levels
   - Shows sentiment and suggested actions

7. **How Musashi Works Section**
   - Explains the data pipeline
   - Shows Polymarket, Kalshi, and analysis flow

## Running Both API and Frontend Together

From the root directory:

```bash
pnpm dev:full
```

This will start both servers in one terminal.

## Stopping the Servers

- Press `Ctrl+C` in the terminal to stop either server
- The frontend (Vite) will automatically reload on file changes

## Troubleshooting

### "Cannot GET /api/health"
- Make sure the API server is running on port 3000
- Check that the proxy in `frontend/vite.config.ts` is correct

### "Cannot find module 'react'"
- Run `pnpm install` in the frontend directory

### Dark mode not persisting
- Check that localStorage is enabled in your browser
- Clear browser cache and refresh

### Port 5173 already in use
- Change the port in `frontend/vite.config.ts`
- Or kill the process: `npx kill-port 5173`

## Data Displayed

The frontend fetches:

- **Markets**: Mock data for demonstration (replace with live API calls)
- **Health**: Real API health check (refreshed every 10 seconds)
- **Arbitrage**: Real arbitrage opportunities from the API (refreshed every 30 seconds)
- **Text Analysis**: On-demand when you submit text

## Browser Support

- Chrome/Chromium 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Next Steps

1. Install dependencies: `pnpm install` (in frontend/)
2. Start API: `pnpm dev` (from root)
3. Start Frontend: `pnpm frontend:dev` (from root) or `pnpm dev` (from frontend/)
4. Open browser to `http://localhost:5173`
5. Explore the dashboard and test the text analyzer!
