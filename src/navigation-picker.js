const GOOGLE_MAPS_BASE = 'https://www.google.com/maps/dir/?api=1';
const WAZE_BASE = 'https://waze.com/ul';
const YAHOO_MAP_SEARCH = 'https://map.yahoo.co.jp/search';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function httpUrl(value) {
  const source = text(value);
  if (!source) return '';
  try {
    const url = new URL(source);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch (error) {
    return '';
  }
}

function coordinatePair(value) {
  const source = text(value);
  if (!source) return null;
  let decoded = source;
  try { decoded = decodeURIComponent(source); } catch (error) { /* Use the original string. */ }
  const match = decoded.match(/(?:^|[@?=,&/\s])(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)(?:$|[?&#,/\s])/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

export function navigationDestination(source = {}) {
  const mapQuery = text(source.mapQuery);
  const mapUrl = httpUrl(source.mapUrl);
  const title = text(source.title);
  const coordinates = coordinatePair(mapQuery) || coordinatePair(mapUrl);
  const query = mapQuery || title;
  return { query, mapUrl, title: title || query || '目的地', coordinates };
}

export function buildNavigationTargets(source = {}) {
  const destination = navigationDestination(source);
  const encodedQuery = encodeURIComponent(destination.query);
  const coordinateText = destination.coordinates
    ? `${destination.coordinates.latitude},${destination.coordinates.longitude}`
    : '';
  const googleDestination = coordinateText || destination.query;
  const generatedGoogleUrl = googleDestination
    ? `${GOOGLE_MAPS_BASE}&destination=${encodeURIComponent(googleDestination)}&travelmode=driving&dir_action=navigate`
    : destination.mapUrl;
  const googleUrl = destination.mapUrl || generatedGoogleUrl;
  const wazeUrl = coordinateText
    ? `${WAZE_BASE}?ll=${encodeURIComponent(coordinateText)}&navigate=yes&utm_source=shiori`
    : destination.query
      ? `${WAZE_BASE}?q=${encodedQuery}&navigate=yes&utm_source=shiori`
      : destination.mapUrl;
  const yahooFallback = destination.query
    ? `${YAHOO_MAP_SEARCH}?q=${encodedQuery}`
    : 'https://carnavi.yahoo.co.jp/';
  const yahooAppUrl = destination.coordinates
    ? `yjcarnavi://navi/select?lat=${encodeURIComponent(destination.coordinates.latitude)}&lon=${encodeURIComponent(destination.coordinates.longitude)}&name=${encodeURIComponent(destination.title)}`
    : '';

  return {
    google: { id: 'google', label: 'GOOGLE MAPS', url: googleUrl || destination.mapUrl },
    yahoo: {
      id: 'yahoo', label: 'YAHOO!カーナビ', url: yahooFallback,
      appUrl: yahooAppUrl,
      note: yahooAppUrl ? '現在地からルート検索' : '座標未登録のためYahoo!地図で検索'
    },
    waze: { id: 'waze', label: 'WAZE', url: wazeUrl || destination.mapUrl }
  };
}

export function navigationPreference(value) {
  return ['ask', 'google', 'yahoo', 'waze', 'apple'].includes(value) ? value : 'ask';
}

export function appleMapsUrl(source = {}) {
  const destination = navigationDestination(source);
  const value = destination.coordinates
    ? `${destination.coordinates.latitude},${destination.coordinates.longitude}`
    : destination.query;
  return value ? `https://maps.apple.com/?daddr=${encodeURIComponent(value)}&dirflg=d` : destination.mapUrl;
}
