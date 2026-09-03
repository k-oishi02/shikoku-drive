import { extractGoogleTimelineVisits } from './journey-v4.js';

self.onmessage = event => {
  const { text, startDate, endDate } = event.data || {};
  if (typeof text !== 'string') {
    self.postMessage({ type: 'error', message: 'Timeline JSONが空です。' });
    return;
  }
  try {
    self.postMessage({ type: 'progress', message: 'Timelineを解析中…' });
    const payload = JSON.parse(text);
    const visits = extractGoogleTimelineVisits(payload, { startDate, endDate });
    self.postMessage({ type: 'result', visits });
  } catch (error) {
    self.postMessage({ type: 'error', message: 'JSONを読み込めませんでした。Google Maps Timelineの書き出しファイルを確認してください。' });
  }
};
