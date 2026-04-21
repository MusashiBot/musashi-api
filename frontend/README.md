# Musashi Frontend

A React + TypeScript dashboard for Musashi prediction market intelligence. Displays real-time market data from Polymarket and Kalshi, trading signals, arbitrage opportunities, and sentiment analysis.

## Features

- **Real-time Market Data**: Live feeds from Polymarket and Kalshi
- **Arbitrage Detection**: Identify cross-platform arbitrage opportunities
- **Trading Signals**: AI-powered signal generation with urgency levels
- **Text Analysis**: Analyze tweets and news for market relevance
- **Dark Mode**: Light/dark theme toggle with financial aesthetic
- **Health Monitoring**: API health status and data freshness tracking

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (or npm/yarn)
- Musashi API running locally on `http://127.0.0.1:3000`

### Installation

```bash
cd frontend
pnpm install
```

### Development

From the `frontend/` directory:

```bash
pnpm dev
```

The app will start on `http://localhost:5173` with hot module reloading enabled.

From the root directory:

```bash
pnpm frontend:dev
```

### Building for Production

```bash
pnpm build
```

Output goes to `frontend/dist/`.

### Running Both API and Frontend

From the root directory:

```bash
pnpm dev:full
```

This runs both the API server (on port 3000) and the frontend (on port 5173) concurrently.

## Architecture

### Components

- **Header**: Navigation and theme toggle
- **HealthCard**: API health and service status
- **MarketsCard**: Active markets from both platforms
- **ArbitrageCard**: Cross-platform arbitrage opportunities
- **TextAnalyzer**: Real-time text analysis tool

### API Integration

The frontend communicates with the Musashi API through:

- `/api/health` — System status
- `/api/markets/arbitrage` — Arbitrage opportunities
- `/api/analyze-text` — Text analysis and signal generation
- (Expandable with additional endpoints)

### Dark Mode

Theme preference is stored in `localStorage` and persisted across sessions. The Tailwind CSS `dark:` utilities handle theme-specific styling.

## Technologies

- **React 18** — UI framework
- **TypeScript** — Type safety
- **Vite** — Build tool and dev server
- **Tailwind CSS** — Utility-first styling
- **Axios** — HTTP client

## Environment Variables

Create a `.env.local` file (optional):

```
VITE_API_BASE_URL=http://127.0.0.1:3000
```

By default, the frontend proxies `/api/*` requests to the local API server via Vite's proxy configuration in `vite.config.ts`.

## Development Notes

- The frontend expects the Musashi API to be running on `http://127.0.0.1:3000`
- API requests are proxied through Vite's dev server to avoid CORS issues
- Real market data is fetched on component mount and refreshed at intervals
- The dashboard includes mock market data for demonstration

## Type Safety

Run type checking:

```bash
pnpm typecheck
```

## Future Enhancements

- WebSocket support for real-time updates
- Advanced charting with market price history
- User preferences and watchlists
- Portfolio tracking
- Mobile responsive design improvements
- Advanced filtering and search
