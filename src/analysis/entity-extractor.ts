// Entity Extractor - Extracts named entities from text
// People, organizations, tickers, dates for improved matching

import { hasWordBoundaryMatch } from './text-utils';

export interface ExtractedEntities {
  people: string[];       // ["Jerome Powell", "Sam Altman"]
  tickers: string[];      // ["BTC", "NVDA", "TSLA"]
  organizations: string[]; // ["Federal Reserve", "OpenAI", "NATO"]
  dates: string[];        // ["March 2026", "Q1", "2025"]
  all: string[];          // Combined list for convenience
}

// Known organizations (case-insensitive)
const ORGANIZATIONS = new Set([
  // Government & Policy
  'federal reserve', 'fed', 'fomc', 'white house', 'pentagon', 'congress',
  'senate', 'house', 'treasury', 'sec', 'fda', 'fbi', 'cia', 'doj',
  'nato', 'un', 'united nations', 'world bank', 'imf',

  // Tech Companies
  'openai', 'anthropic', 'google', 'meta', 'facebook', 'apple', 'microsoft',
  'amazon', 'tesla', 'spacex', 'nvidia', 'amd', 'intel', 'ibm', 'oracle',
  'salesforce', 'adobe', 'netflix', 'spotify', 'uber', 'lyft', 'airbnb',

  // Finance
  'goldman sachs', 'jpmorgan', 'morgan stanley', 'blackrock', 'vanguard',
  'fidelity', 'charles schwab', 'citigroup', 'bank of america', 'wells fargo',

  // Crypto
  'coinbase', 'binance', 'ftx', 'kraken', 'gemini', 'tether', 'circle',

  // Sports
  'nfl', 'nba', 'mlb', 'nhl', 'fifa', 'uefa', 'pga', 'formula one', 'f1',

  // News/Media
  'new york times', 'nyt', 'wall street journal', 'wsj', 'bloomberg',
  'reuters', 'associated press', 'ap', 'cnn', 'fox news', 'msnbc',
]);

// Known people patterns (first + last name)
const KNOWN_PEOPLE = new Set([
  // Politics
  'donald trump', 'joe biden', 'kamala harris', 'ron desantis', 'mike pence',
  'barack obama', 'hillary clinton', 'bernie sanders', 'nancy pelosi',
  'mitch mcconnell', 'kevin mccarthy', 'chuck schumer',

  // Finance/Economics
  'jerome powell', 'janet yellen', 'gary gensler', 'warren buffett',
  'elon musk', 'jeff bezos', 'bill gates', 'mark zuckerberg', 'tim cook',

  // Tech
  'sam altman', 'satya nadella', 'sundar pichai', 'jensen huang',
  'lisa su', 'andy jassy', 'dario amodei', 'ilya sutskever',

  // Crypto
  'vitalik buterin', 'changpeng zhao', 'cz', 'sam bankman-fried', 'sbf',

  // Sports
  'lebron james', 'tom brady', 'lionel messi', 'cristiano ronaldo',
]);

/**
 * Extract ticker symbols from text
 * Matches: $BTC, $NVDA, $TSLA, BTC, NVDA (all caps)
 */
function extractTickers(text: string): string[] {
  const tickers: string[] = [];

  // Match $TICKER format
  const dollarMatches = text.matchAll(/\$([A-Z]{2,5})\b/g);
  for (const match of dollarMatches) {
    tickers.push(match[1]);
  }

  // Match standalone all-caps words (3-5 chars) that look like tickers
  // But filter out common words like "USA", "CEO", "NEW"
  const commonWords = new Set(['USA', 'CEO', 'CTO', 'CFO', 'CMO', 'CIO', 'VP', 'NEW', 'OLD', 'YES', 'NO']);
  const standaloneMatches = text.matchAll(/\b([A-Z]{2,5})\b/g);

  for (const match of standaloneMatches) {
    const word = match[1];
    // Only include if not a common word and follows ticker patterns
    if (!commonWords.has(word) && /^[A-Z]{3,5}$/.test(word)) {
      tickers.push(word);
    }
  }

  return [...new Set(tickers)]; // Deduplicate
}

/**
 * Extract people names from text
 * Looks for: capitalized word pairs, known people
 */
function extractPeople(text: string): string[] {
  const people: string[] = [];

  // Fix D: use word-boundary matching so "trump" doesn't match inside "trumpet"
  // and "donald trump" doesn't match inside the middle of a longer token.
  // Previously: lowerText.includes(person) — substring match, which produced
  // false positives on short entries and was inconsistent for multi-word names.
  for (const person of KNOWN_PEOPLE) {
    if (hasWordBoundaryMatch(text, person)) {
      people.push(person);
    }
  }

  // Extract capitalized word pairs that look like names
  // Pattern: Capitalized word followed by capitalized word
  // Example: "Jerome Powell", "Sam Altman"
  const nameMatches = text.matchAll(/\b([A-Z][a-z]+(?:'[A-Z][a-z]+)?)\s+([A-Z][a-z]+(?:'[A-Z][a-z]+)?)\b/g);

  for (const match of nameMatches) {
    const fullName = `${match[1]} ${match[2]}`;
    const fullNameLower = fullName.toLowerCase();

    // Filter out common false positives
    const falsePositives = [
      'new york', 'los angeles', 'san francisco', 'north korea', 'south korea',
      'white house', 'supreme court', 'wall street', 'silicon valley',
      'middle east', 'united states', 'united kingdom', 'european union',
    ];

    if (!falsePositives.includes(fullNameLower)) {
      people.push(fullNameLower);
    }
  }

  return [...new Set(people)]; // Deduplicate
}

/**
 * Extract organizations from text
 */
function extractOrganizations(text: string): string[] {
  const organizations: string[] = [];

  // Fix D: use word-boundary matching to stop short abbreviations like "fed",
  // "sec", "ap", "un", "cia" from falsely matching inside "fedex", "second",
  // "apple", "until", "social", etc. Previously: lowerText.includes(org).
  for (const org of ORGANIZATIONS) {
    if (hasWordBoundaryMatch(text, org)) {
      organizations.push(org);
    }
  }

  return [...new Set(organizations)]; // Deduplicate
}

/**
 * Extract dates and timeframes from text
 * Matches: "March 2026", "Q1 2025", "2024", "next week", "this month"
 */
function extractDates(text: string): string[] {
  const dates: string[] = [];

  // Month + Year: "March 2026", "Mar 2026"
  const monthYearMatches = text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(202[4-9]|20[3-9]\d)\b/gi);
  for (const match of monthYearMatches) {
    dates.push(match[0].toLowerCase());
  }

  // Quarter + Year: "Q1 2025", "Q4 2024"
  const quarterMatches = text.matchAll(/\bQ([1-4])\s*(202[4-9]|20[3-9]\d)\b/gi);
  for (const match of quarterMatches) {
    dates.push(`q${match[1]} ${match[2]}`);
  }

  // Standalone years: 2024, 2025, etc.
  const yearMatches = text.matchAll(/\b(202[4-9]|20[3-9]\d)\b/g);
  for (const match of yearMatches) {
    dates.push(match[1]);
  }

  // Relative timeframes
  const relativeTimeframes = [
    'next week', 'next month', 'next year', 'next quarter',
    'this week', 'this month', 'this year', 'this quarter',
    'by end of year', 'end of month', 'eoy', 'eom',
  ];

  const lowerText = text.toLowerCase();
  for (const timeframe of relativeTimeframes) {
    if (lowerText.includes(timeframe)) {
      dates.push(timeframe);
    }
  }

  return [...new Set(dates)]; // Deduplicate
}

/**
 * Extract all entities from text
 */
export function extractEntities(text: string): ExtractedEntities {
  const people = extractPeople(text);
  const tickers = extractTickers(text);
  const organizations = extractOrganizations(text);
  const dates = extractDates(text);

  // Combine all for convenience
  const all = [
    ...people,
    ...tickers,
    ...organizations,
    ...dates,
  ];

  return {
    people,
    tickers,
    organizations,
    dates,
    all,
  };
}

/**
 * Check if a keyword is an entity
 * Used for applying entity weight boost in scoring
 */
export function isEntity(keyword: string, entities: ExtractedEntities): boolean {
  const lower = keyword.toLowerCase();

  // Check if it's in any entity list
  return entities.people.includes(lower) ||
         entities.tickers.includes(keyword.toUpperCase()) ||
         entities.organizations.includes(lower) ||
         entities.dates.includes(lower);
}
