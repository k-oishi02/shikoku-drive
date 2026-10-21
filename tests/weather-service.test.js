import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEATHER_REFRESH_MS,
  WEATHER_CACHE_KEY_PREFIX,
  readLocalWeatherCache,
  writeLocalWeatherCache,
  loadWeatherCache,
  saveWeatherCache,
  getWeatherCondition,
  parseWeatherData,
  renderWeather
} from '../src/weather-service.js';

describe('Weather Service Suite (Feature F17)', () => {
  describe('getWeatherCondition mapping', () => {
    it('maps weather codes to accurate conditions and icons', () => {
      assert.deepEqual(getWeatherCondition(0), { cond: '快晴', icon: 'SUN' });
      assert.deepEqual(getWeatherCondition(1), { cond: '晴れ・曇り', icon: 'CLOUD' });
      assert.deepEqual(getWeatherCondition(2), { cond: '晴れ・曇り', icon: 'CLOUD' });
      assert.deepEqual(getWeatherCondition(3), { cond: '晴れ・曇り', icon: 'CLOUD' });
      assert.deepEqual(getWeatherCondition(45), { cond: '霧', icon: 'FOG' });
      assert.deepEqual(getWeatherCondition(48), { cond: '霧', icon: 'FOG' });
      assert.deepEqual(getWeatherCondition(51), { cond: '霧雨', icon: 'RAIN' });
      assert.deepEqual(getWeatherCondition(61), { cond: '雨', icon: 'RAIN' });
      assert.deepEqual(getWeatherCondition(71), { cond: '雪', icon: 'SNOW' });
      assert.deepEqual(getWeatherCondition(80), { cond: 'にわか雨', icon: 'RAIN' });
      assert.deepEqual(getWeatherCondition(95), { cond: '雷雨', icon: 'STORM' });
      assert.deepEqual(getWeatherCondition(99), { cond: '雷雨', icon: 'STORM' });
    });

    it('handles invalid, NaN, and unmapped codes gracefully', () => {
      assert.deepEqual(getWeatherCondition(NaN), { cond: '取得不能', icon: 'ERR' });
      assert.deepEqual(getWeatherCondition(undefined), { cond: '取得不能', icon: 'ERR' });
      assert.deepEqual(getWeatherCondition(50), { cond: '天候不明', icon: '--' });
    });
  });

  describe('parseWeatherData API parser', () => {
    it('correctly parses Open-Meteo payload for targetDate', () => {
      const mockApi = {
        daily: {
          time: ['2026-11-07', '2026-11-08'],
          temperature_2m_max: [18.4, 19.1],
          temperature_2m_min: [9.2, 11.0],
          weather_code: [1, 61],
          precipitation_probability_max: [10, 80],
          sunset: ['2026-11-07T17:05', '2026-11-08T17:04']
        }
      };

      const result = parseWeatherData(mockApi, '2026-11-07');
      assert.equal(result.forecastDate, '2026-11-07');
      assert.equal(result.temp, '18°C');
      assert.equal(result.range, '9°C / 18°C');
      assert.equal(result.pop, '10%');
      assert.equal(result.cond, '晴れ・曇り');
      assert.equal(result.icon, 'CLOUD');
      assert.equal(result.sunset, '17:05');
      assert.ok(typeof result.updated === 'string');
    });

    it('returns unavailable fallback for out-of-range future date', () => {
      const mockApi = {
        daily: {
          time: ['2026-11-01'],
          temperature_2m_max: [20.0],
          temperature_2m_min: [10.0]
        }
      };

      const result = parseWeatherData(mockApi, '2026-12-25');
      assert.equal(result.unavailable, true);
      assert.equal(result.temp, '—');
      assert.equal(result.range, '旅行日の予報はまだ未提供');
      assert.equal(result.cond, '出発前に再取得');
      assert.equal(result.icon, '⏳');
    });
  });

  describe('Local Storage Cache & Schema', () => {
    let mockStorage;
    let origLocalStorage;

    beforeEach(() => {
      origLocalStorage = global.localStorage;
      const map = new Map();
      mockStorage = {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear(),
        _map: map
      };
      global.localStorage = mockStorage;
    });

    afterEach(() => {
      global.localStorage = origLocalStorage;
    });

    it('saves and reads weather cache with expected prefix', () => {
      const entry = {
        timestamp: Date.now(),
        cachedAt: new Date().toISOString(),
        data: { temp: '20°C', cond: '快晴' }
      };

      writeLocalWeatherCache('takamatsu', entry);
      const raw = mockStorage.getItem(`${WEATHER_CACHE_KEY_PREFIX}takamatsu`);
      assert.ok(raw);

      const readBack = readLocalWeatherCache('takamatsu');
      assert.deepEqual(readBack, entry);

      // Verify alias
      assert.deepEqual(loadWeatherCache('takamatsu'), entry);
    });

    it('handles corrupted JSON safely by returning null', () => {
      mockStorage.setItem(`${WEATHER_CACHE_KEY_PREFIX}corrupt`, 'invalid-json{{');
      assert.equal(readLocalWeatherCache('corrupt'), null);
      assert.equal(loadWeatherCache('corrupt'), null);
    });
  });

  describe('renderWeather & Offline UI Indicators', () => {
    let origDocument;
    let elements;

    beforeEach(() => {
      origDocument = global.document;
      elements = {
        'weather-summary': { textContent: '' },
        'w-temp': { textContent: '' },
        'w-range': { textContent: '' },
        'w-pop': { textContent: '' },
        'w-sunset': { textContent: '' },
        'w-cond': { textContent: '' },
        'w-icon': { textContent: '' },
        'w-updated': { textContent: '' }
      };

      global.document = {
        getElementById: (id) => elements[id] || null
      };
    });

    afterEach(() => {
      global.document = origDocument;
    });

    it('renders normal weather with location prefix in summary', () => {
      renderWeather({
        temp: '18°C',
        range: '10°C / 18°C',
        pop: '20%',
        cond: '晴れ',
        icon: '☀️',
        sunset: '17:10',
        updated: '12:00',
        forecastDate: '2026-11-07',
        isOffline: false
      }, '高松');

      assert.equal(elements['weather-summary'].textContent, '高松 11/07 · 晴れ 18°C / 雨 20%');
      assert.equal(elements['w-temp'].textContent, '18°C');
      assert.equal(elements['w-cond'].textContent, '晴れ');
    });

    it('prepends offline badge 📴 when w.isOffline is true', () => {
      renderWeather({
        temp: '18°C',
        range: '10°C / 18°C',
        pop: '20%',
        cond: '晴れ',
        icon: '☀️',
        sunset: '17:10',
        updated: '12:00取得分・オフライン表示',
        forecastDate: '2026-11-07',
        isOffline: true
      }, '高松');

      assert.ok(elements['weather-summary'].textContent.startsWith('📴 高松'));
      assert.ok(elements['weather-summary'].textContent.includes('晴れ 18°C'));
    });
  });
});
