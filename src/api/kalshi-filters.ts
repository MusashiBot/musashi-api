export function isSimpleMarket(params: {
  title: string;
  tickerOrPlatformId: string;
  mveCollectionTicker?: string | null;
}): boolean {
  const { title, tickerOrPlatformId, mveCollectionTicker } = params;
  if (!title || !tickerOrPlatformId) return false;
  if (mveCollectionTicker) return false;
  if (/MULTIGAME|MVE/i.test(tickerOrPlatformId)) return false;
  if (/^yes\s/i.test(title.trim())) return false;
  const commas = (title.match(/,/g) || []).length;
  if (commas > 2) return false;
  return true;
}
