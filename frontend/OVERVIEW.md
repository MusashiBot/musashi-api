# Frontend Overview

## What This Frontend Is

This frontend is the public-facing presentation layer for the Musashi API.

It exists to show visitors what Musashi does:

- surface live prediction-market intelligence
- demonstrate the shape of the API
- present market activity, arbitrage, and signal monitoring in a clear visual format
- give developers and partners a fast way to understand the product

## What This Frontend Is Not

This frontend is not a user account product.

It is not designed around:

- login
- personal onboarding
- user-specific state
- private dashboards
- saved watchlists
- portfolio management

Everything shown here should make sense to a general visitor without requiring authentication.

## Product Role

The frontend should behave like a public terminal and product showcase for Musashi's market intelligence layer.

Its main job is to make the API feel real, active, and legible. It should help someone quickly understand:

- what data Musashi can access
- what kinds of signals Musashi can generate
- what the platform can analyze in real time
- why the API is useful

## UX Principles

This frontend should:

- prioritize clarity over depth
- feel live and credible even when some data streams are quiet
- avoid exposing raw empty states that look like application failure
- emphasize public market data and capability demonstration
- keep the experience lightweight, fast, and understandable on first visit

## Data Expectations

For a public-facing experience, the most stable modules should rely on durable market data first.

Signal-driven modules may be empty at times, but their empty states should still communicate that the system is active and monitoring the market rather than broken.

## Success Criteria

The frontend is successful when a new visitor can understand, within a few seconds, that Musashi is:

- an API for prediction-market intelligence
- connected to live market sources
- capable of matching text and events to tradeable markets
- useful without requiring them to sign in first
