#!/usr/bin/env node
/**
 * Test script for performance tracking endpoints
 * 
 * Usage:
 *   node --import tsx scripts/test-performance-endpoints.ts
 */

const BASE_URL = process.env.MUSASHI_API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.INTERNAL_API_KEY || 'test-key-123';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration?: number;
}

const results: TestResult[] = [];

async function testPerformanceMetrics(): Promise<void> {
  const start = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/api/metrics/performance`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Validate response structure
    if (!data.success || !data.data) {
      throw new Error('Invalid response structure');
    }

    const metrics = data.data;
    
    // Check required fields
    const requiredFields = [
      'win_rate_24h', 'win_rate_7d', 'win_rate_30d',
      'brier_score_24h', 'brier_score_7d', 'brier_score_30d',
      'top_categories', 'worst_false_positives', 'signal_stats', 'timestamp'
    ];

    for (const field of requiredFields) {
      if (!(field in metrics)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Validate signal_stats structure
    const stats = metrics.signal_stats;
    if (typeof stats.total_generated !== 'number' ||
        typeof stats.total_resolved !== 'number' ||
        typeof stats.pending_resolution !== 'number') {
      throw new Error('Invalid signal_stats structure');
    }

    console.log('\n✓ Performance metrics endpoint test passed');
    console.log(`  Total signals: ${stats.total_generated}`);
    console.log(`  Resolved: ${stats.total_resolved}`);
    console.log(`  Pending: ${stats.pending_resolution}`);
    console.log(`  Brier Score (30d): ${metrics.brier_score_30d.toFixed(3)}`);

    results.push({
      name: 'Performance Metrics',
      passed: true,
      duration: Date.now() - start,
    });
  } catch (error) {
    console.error('\n✗ Performance metrics endpoint test failed');
    console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    results.push({
      name: 'Performance Metrics',
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    });
  }
}

async function testResolveMarket(): Promise<void> {
  const start = Date.now();
  try {
    // Test with a dummy market ID (should fail if no signals exist, but endpoint should work)
    const payload = {
      market_id: 'test_market_123',
      platform: 'polymarket',
      outcome: 'YES',
      bankroll: 1000,
    };

    const response = await fetch(`${BASE_URL}/api/internal/resolve-market`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error('Response indicated failure');
    }

    console.log('\n✓ Resolve market endpoint test passed');
    console.log(`  Signals updated: ${data.signals_updated}`);
    console.log(`  Total P&L: ${data.total_pl?.toFixed(2) || 0}`);

    results.push({
      name: 'Resolve Market',
      passed: true,
      duration: Date.now() - start,
    });
  } catch (error) {
    console.error('\n✗ Resolve market endpoint test failed');
    console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    results.push({
      name: 'Resolve Market',
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    });
  }
}

async function testAuthenticationFailure(): Promise<void> {
  const start = Date.now();
  try {
    const payload = {
      market_id: 'test_market_123',
      platform: 'polymarket',
      outcome: 'YES',
    };

    const response = await fetch(`${BASE_URL}/api/internal/resolve-market`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Intentionally omit API key
      },
      body: JSON.stringify(payload),
    });

    if (response.status !== 401) {
      throw new Error(`Expected 401 Unauthorized, got ${response.status}`);
    }

    console.log('\n✓ Authentication failure test passed (correctly rejected)');

    results.push({
      name: 'Authentication Failure',
      passed: true,
      duration: Date.now() - start,
    });
  } catch (error) {
    console.error('\n✗ Authentication failure test failed');
    console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    results.push({
      name: 'Authentication Failure',
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    });
  }
}

async function testInvalidPayload(): Promise<void> {
  const start = Date.now();
  try {
    const payload = {
      // Missing required fields
      platform: 'polymarket',
    };

    const response = await fetch(`${BASE_URL}/api/internal/resolve-market`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (response.status !== 400) {
      throw new Error(`Expected 400 Bad Request, got ${response.status}`);
    }

    const data = await response.json();
    if (!data.error || !data.error.includes('Missing required fields')) {
      throw new Error('Expected validation error message');
    }

    console.log('\n✓ Invalid payload test passed (correctly rejected)');

    results.push({
      name: 'Invalid Payload',
      passed: true,
      duration: Date.now() - start,
    });
  } catch (error) {
    console.error('\n✗ Invalid payload test failed');
    console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    results.push({
      name: 'Invalid Payload',
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    });
  }
}

async function isApiReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${BASE_URL}/api/health`, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Performance Tracking Endpoints Test Suite');
  console.log('='.repeat(60));
  console.log(`\nBase URL: ${BASE_URL}`);
  console.log(`API Key: ${API_KEY.substring(0, 8)}...`);

  if (!(await isApiReachable())) {
    console.log(
      '\nSKIP: API not reachable at ' +
        `${BASE_URL}. Start local server (pnpm dev) or set MUSASHI_API_BASE_URL to a deployed URL.`
    );
    process.exit(0);
  }

  await testPerformanceMetrics();
  await testResolveMarket();
  await testAuthenticationFailure();
  await testInvalidPayload();

  console.log('\n' + '='.repeat(60));
  console.log('Test Results Summary');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  results.forEach(result => {
    const icon = result.passed ? '✓' : '✗';
    const duration = result.duration ? ` (${result.duration}ms)` : '';
    console.log(`${icon} ${result.name}${duration}`);
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
  });

  console.log(`\nTotal: ${results.length} tests`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Check the errors above.');
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
  }
}

const isThisScriptEntry =
  typeof process.argv[1] === 'string' && process.argv[1].includes('test-performance-endpoints');

if (isThisScriptEntry) {
  main().catch(error => {
    console.error('\nFatal error:', error);
    process.exit(1);
  });
}

export { main as testPerformanceEndpoints };
