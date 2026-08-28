export function isGoogleMapsUrl(value) {
  if (typeof value !== 'string') return false;
  if (!value || value.length > 2048) return false;
  if (value.trim() !== value) return false;
  if (/\s/.test(value)) return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  if (value.includes('\\')) return false;

  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host === 'maps.app.goo.gl') {
    return /^\/[a-zA-Z0-9]+$/.test(path);
  }
  if (host === 'goo.gl') {
    return /^\/maps\/[a-zA-Z0-9]+$/.test(path);
  }
  if (
    host === 'www.google.com' ||
    host === 'google.com' ||
    host === 'www.google.co.jp' ||
    host === 'google.co.jp'
  ) {
    return path === '/maps' || path.startsWith('/maps/');
  }
  if (host === 'maps.google.com' || host === 'maps.google.co.jp') {
    return path === '/' || path === '' || path === '/maps' || path.startsWith('/maps/');
  }
  return false;
}

function buildSafeSearchUrl(query) {
  if (typeof query !== 'string' || !query) return '';
  if (/[\x00-\x1f\x7f]/.test(query)) return '';
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://www.google.com/maps/search/?api=1&query=${encoded}`;
    return url.length <= 2048 ? url : '';
  } catch {
    return '';
  }
}

function buildSafeRouteUrl(origin, destination) {
  if (typeof destination !== 'string' || !destination) return '';
  if (/[\x00-\x1f\x7f]/.test(destination)) return '';
  if (!origin) {
    return buildSafeSearchUrl(destination);
  }
  if (typeof origin !== 'string' || /[\x00-\x1f\x7f]/.test(origin)) return '';
  try {
    const encOrig = encodeURIComponent(origin);
    const encDest = encodeURIComponent(destination);
    const url = `https://www.google.com/maps/dir/?api=1&origin=${encOrig}&destination=${encDest}`;
    return url.length <= 2048 ? url : '';
  } catch {
    return '';
  }
}

function sanitizeSearchQuery(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 300) return '';
  if (/[\x00-\x1f\x7f]/.test(text)) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:|^(\/\/)/.test(trimmed)) return '';
  if (isGoogleMapsUrl(text)) return '';
  if (!buildSafeSearchUrl(trimmed)) return '';
  return trimmed;
}

export function validateMapFields(source, { allowLegacy = true } = {}) {
  const errors = [];
  if (!source || typeof source !== 'object') return errors;

  const { mapQuery, mapUrl } = source;

  if (mapQuery !== undefined && typeof mapQuery !== 'string') {
    errors.push('検索語（mapQuery）は文字列で指定してください。');
  }
  if (mapUrl !== undefined && typeof mapUrl !== 'string') {
    errors.push('共有URL（mapUrl）は文字列で指定してください。');
  }

  const rawQuery = typeof mapQuery === 'string' ? mapQuery : '';
  const rawUrl = typeof mapUrl === 'string' ? mapUrl : '';

  if (rawQuery !== '') {
    const isUrl = isGoogleMapsUrl(rawQuery);
    if (isUrl) {
      if (allowLegacy) {
        if (rawUrl !== '' && rawUrl !== rawQuery) {
          errors.push('検索語と共有URLの両方に異なるURLが指定されており曖昧です。');
        }
      } else {
        errors.push('検索語にURLは指定できません。');
      }
    } else {
      if (rawQuery.trim().length > 300) {
        errors.push('検索語は300文字以内で指定してください。');
      }
      if (/[\x00-\x1f\x7f]/.test(rawQuery)) {
        errors.push('検索語に無効な制御文字が含まれています。');
      }
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:|^(\/\/)/.test(rawQuery.trim())) {
        errors.push('検索語にURLやスキームを含む文字列は指定できません。');
      } else if (rawQuery.trim() !== '') {
        const testUrl = buildSafeSearchUrl(rawQuery.trim());
        if (!testUrl) {
          errors.push('検索語が長すぎるか無効な文字が含まれているためGoogle Maps URLを生成できません。');
        }
      }
    }
  }

  if (rawUrl !== '') {
    if (!isGoogleMapsUrl(rawUrl)) {
      errors.push('有効なGoogle Mapsの共有URLを指定してください。');
    }
  }

  return errors;
}

export function resolveMapFields(source) {
  if (!source || typeof source !== 'object') {
    return { mapQuery: '', mapUrl: '' };
  }

  const rawUrl = typeof source.mapUrl === 'string' ? source.mapUrl : '';
  const rawQuery = typeof source.mapQuery === 'string' ? source.mapQuery : '';

  let finalUrl = '';
  let finalQuery = '';

  if (rawUrl !== '' && isGoogleMapsUrl(rawUrl)) {
    finalUrl = rawUrl;
  }

  if (rawQuery !== '') {
    if (isGoogleMapsUrl(rawQuery)) {
      if (!finalUrl) {
        finalUrl = rawQuery;
      }
    } else {
      const sanitized = sanitizeSearchQuery(rawQuery);
      if (sanitized) {
        finalQuery = sanitized;
      }
    }
  }

  return { mapQuery: finalQuery, mapUrl: finalUrl };
}

export function mapSearchQuery(source) {
  const resolved = resolveMapFields(source);
  if (resolved.mapQuery) {
    return resolved.mapQuery;
  }
  if (source && typeof source === 'object' && typeof source.title === 'string') {
    return sanitizeSearchQuery(source.title);
  }
  return '';
}

export function mapHref(source) {
  const resolved = resolveMapFields(source);
  if (resolved.mapUrl) {
    return resolved.mapUrl;
  }
  const query = mapSearchQuery(source);
  return query ? buildSafeSearchUrl(query) : '';
}

export function mapRouteHref(origin, destination) {
  const destQuery = mapSearchQuery(destination);
  if (!destQuery) return '';
  const origQuery = mapSearchQuery(origin);
  return buildSafeRouteUrl(origQuery, destQuery);
}
