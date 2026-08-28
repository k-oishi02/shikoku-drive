import { validateMapFields } from './map-links.js';

function isNonArrayObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function isInteger(val, min, max) {
  return typeof val === 'number' && Number.isInteger(val) && val >= min && val <= max;
}

function isValidHHmm(val) {
  if (typeof val !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(val);
}

function isDangerousScheme(urlStr) {
  if (typeof urlStr !== 'string') return true;
  if (urlStr === '') return false;
  if (/[\x00-\x20\x7f\\\\]/.test(urlStr)) return true;
  try {
    const parsed = new URL(urlStr);
    return /^(javascript|data|file|blob|about|vbscript):$/i.test(parsed.protocol)
      || !/^[a-z][a-z0-9+.-]{1,31}:$/i.test(parsed.protocol)
      || Boolean(parsed.username || parsed.password);
  } catch { return true; }
}

function isValidHttpsUrl(val, maxLen = 2000) {
  if (typeof val !== 'string') return false;
  if (!val || val.length > maxLen) return false;
  if (/\s/.test(val) || /[\x00-\x1f\x7f]/.test(val) || val.includes('\\')) return false;
  try {
    const u = new URL(val);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443');
  } catch {
    return false;
  }
}

function checkOptionalString(val, maxLen, label, errors) {
  if (val === undefined) return;
  if (typeof val !== 'string') {
    errors.push(`${label}は文字列で指定してください。`);
  } else if (val.length > maxLen) {
    errors.push(`${label}は${maxLen}文字以内で指定してください。`);
  }
}

function checkOptionalHttpsUrl(val, label, errors) {
  if (val === undefined || val === '') return;
  if (!isValidHttpsUrl(val, 2000)) {
    errors.push(`${label}は有効なHTTPS URL（2000文字以内）で指定してください。`);
  }
}

export function validateCandidateInput(c) {
  const errors = [];
  if (!isNonArrayObject(c)) {
    return ['候補データはオブジェクトである必要があります。'];
  }

  if (typeof c.title !== 'string' || c.title.trim() === '') {
    errors.push('候補のタイトルは必須です。');
  } else if (c.title.length > 120) {
    errors.push('候補のタイトルは120文字以内で指定してください。');
  }

  checkOptionalString(c.id, 80, '候補ID（id）', errors);
  checkOptionalString(c.candidateId, 80, '候補ID（candidateId）', errors);
  checkOptionalString(c.notes, 2000, '候補メモ', errors);
  checkOptionalString(c.officialLabel, 40, '公式ラベル', errors);
  checkOptionalString(c.assignedDay, 20, '配置日', errors);
  checkOptionalString(c.assignedCardId, 80, '配置カードID', errors);
  checkOptionalString(c.createdAt, 40, '作成日時', errors);
  checkOptionalString(c.updatedAt, 40, '更新日時', errors);

  const rawId = c.id || c.candidateId;
  if (c.id && c.candidateId && c.id !== c.candidateId) errors.push('候補IDと旧候補IDが一致していません。');
  const candidateFields = new Set(['id','candidateId','title','category','priority','durationMinutes','status','mapQuery','mapUrl','official','officialLabel','tabelog','jalan','notes','assignedDay','assignedCardId','createdAt','updatedAt','placementUndo','sourceSuggestion']);
  for (const key of Object.keys(c)) if (!candidateFields.has(key)) errors.push(`未対応の候補項目「${key}」があります。削除せずに読込を停止します。`);
  if (typeof rawId === 'string' && rawId !== '') {
    if (!/^[a-z0-9][a-z0-9_-]{3,79}$/i.test(rawId)) {
      errors.push('候補IDの形式が不正です（半角英数字・ハイフン・アンダースコア4〜80文字）。');
    }
  }

  if (c.category !== undefined && !['gourmet', 'sightseeing', 'hotel', 'transport', 'other'].includes(c.category)) {
    errors.push('候補のカテゴリーが不正です。');
  }
  if (c.priority !== undefined && !['high', 'normal', 'low'].includes(c.priority)) {
    errors.push('候補の優先度が不正です。');
  }
  if (c.status !== undefined && !['draft', 'assigned'].includes(c.status)) {
    errors.push('候補のステータスが不正です。');
  }

  if (c.durationMinutes !== undefined && !isInteger(c.durationMinutes, 1, 1440)) {
    errors.push('所要時間は1〜1440分の整数で指定してください。');
  }

  checkOptionalHttpsUrl(c.official, '公式URL', errors);
  checkOptionalHttpsUrl(c.tabelog, '食べログURL', errors);
  checkOptionalHttpsUrl(c.jalan, 'じゃらんURL', errors);

  errors.push(...validateMapFields(c, { allowLegacy: true }));

  if (c.placementUndo !== undefined && !isNonArrayObject(c.placementUndo)) {
    errors.push('配置取消情報（placementUndo）はオブジェクトで指定してください。');
  }

  if (c.sourceSuggestion !== undefined) {
    if (!isNonArrayObject(c.sourceSuggestion)) {
      errors.push('採用元情報（sourceSuggestion）はオブジェクトで指定してください。');
    } else {
      const allowedSourceKeys = new Set(['roomId', 'suggestionId', 'adoptedAt']);
      for (const k of Object.keys(c.sourceSuggestion)) {
        if (!allowedSourceKeys.has(k)) {
          errors.push(`採用元情報に未対応の項目「${k}」があります。`);
        }
      }
      if (typeof c.sourceSuggestion.roomId !== 'string' || c.sourceSuggestion.roomId.trim() === '' || c.sourceSuggestion.roomId.length > 160) {
        errors.push('採用元情報のルームID（roomId）が不正です。');
      }
      if (typeof c.sourceSuggestion.suggestionId !== 'string' || c.sourceSuggestion.suggestionId.trim() === '' || c.sourceSuggestion.suggestionId.length > 80) {
        errors.push('採用元情報の提案ID（suggestionId）が不正です。');
      }
      checkOptionalString(c.sourceSuggestion.adoptedAt, 40, '採用日時（adoptedAt）', errors);
    }
  }

  return errors;
}

export function validatePlanningInput(p) {
  const errors = [];
  if (!isNonArrayObject(p)) {
    return ['計画データはオブジェクトである必要があります。'];
  }
  for (const key of Object.keys(p)) if (!['schemaVersion','candidates','notes','lastSavedAt'].includes(key)) errors.push(`未対応の計画項目「${key}」があります。削除せずに読込を停止します。`);

  if (p.candidates !== undefined) {
    if (!Array.isArray(p.candidates)) {
      errors.push('候補一覧（candidates）は配列で指定してください。');
    } else {
      const seenCandidateIds = new Set();
      for (let i = 0; i < p.candidates.length; i++) {
        const cand = p.candidates[i];
        const candErrors = validateCandidateInput(cand);
        for (const err of candErrors) {
          errors.push(`候補[${i + 1}]: ${err}`);
        }
        if (isNonArrayObject(cand)) {
          const cid = cand.id || cand.candidateId;
          if (typeof cid === 'string' && cid !== '') {
            if (seenCandidateIds.has(cid)) {
              errors.push(`候補[${i + 1}]: 候補ID「${cid}」が重複しています。`);
            } else {
              seenCandidateIds.add(cid);
            }
          }
        }
      }
    }
  }

  checkOptionalString(p.notes, 5000, '計画メモ', errors);
  checkOptionalString(p.lastSavedAt, 40, '最終保存日時', errors);

  if (p.schemaVersion !== undefined && p.schemaVersion !== 3) {
    errors.push('スキーマバージョンは3である必要があります。');
  }

  return errors;
}

export function validateTripInput(t) {
  const errors = [];
  if (!isNonArrayObject(t)) {
    return ['旅程データはオブジェクトである必要があります。'];
  }

  if (typeof t.tripId !== 'string' || !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(t.tripId)) {
    errors.push('旅程ID（tripId）は半角英数字・ハイフン・アンダースコア3〜40文字で指定してください。');
  }

  if (typeof t.title !== 'string' || t.title.trim() === '') {
    errors.push('旅程のタイトルは必須です。');
  } else if (t.title.length > 120) {
    errors.push('旅程のタイトルは120文字以内で指定してください。');
  }

  checkOptionalString(t.subtitle, 160, 'サブタイトル', errors);
  checkOptionalString(t.catchphrase, 200, 'キャッチフレーズ', errors);
  checkOptionalString(t.startDate, 10, '開始日', errors);
  checkOptionalString(t.endDate, 10, '終了日', errors);

  if (t.days !== undefined) {
    if (!isNonArrayObject(t.days)) {
      errors.push('日程一覧（days）はオブジェクトである必要があります。');
    } else {
      const seenCardIds = new Set();
      for (const [dayKey, cards] of Object.entries(t.days)) {
        if (!/^day\d+$/.test(dayKey)) {
          errors.push(`日程キー「${dayKey}」の形式が不正です（day1, day2等）。`);
        }
        if (!Array.isArray(cards)) {
          errors.push(`${dayKey}のカード一覧は配列である必要があります。`);
          continue;
        }

        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const label = `${dayKey} カード[${i + 1}]`;
          if (!isNonArrayObject(card)) {
            errors.push(`${label}はオブジェクトである必要があります。`);
            continue;
          }

          checkOptionalString(card.time, 17, `${label}の時刻`, errors);
          checkOptionalString(card.badge, 2000, `${label}のバッジ`, errors);
          checkOptionalString(card.title, 120, `${label}のタイトル`, errors);
          checkOptionalString(card.desc, 240, `${label}の説明`, errors);
          checkOptionalString(card.officialLabel, 2000, `${label}の公式ラベル`, errors);
          checkOptionalString(card.image, 2000, `${label}の画像URL`, errors);

          if (card.cardId !== undefined) {
            if (typeof card.cardId !== 'string' || card.cardId.length > 80) {
              errors.push(`${label}のカードIDは80文字以内の文字列で指定してください。`);
            } else if (card.cardId !== '') {
              if (!/^[a-z0-9][a-z0-9_-]{5,79}$/i.test(card.cardId)) {
                errors.push(`${label}のカードID形式が不正です（半角英数字・ハイフン・アンダースコア6〜80文字）。`);
              }
              if (seenCardIds.has(card.cardId)) {
                errors.push(`${label}: カードID「${card.cardId}」が他のカードと重複しています。`);
              } else {
                seenCardIds.add(card.cardId);
              }
            }
          }

          errors.push(...validateMapFields(card, { allowLegacy: true }));

          checkOptionalHttpsUrl(card.official, `${label}の公式URL`, errors);
          checkOptionalHttpsUrl(card.tabelog, `${label}の食べログURL`, errors);
          checkOptionalHttpsUrl(card.jalan, `${label}のじゃらんURL`, errors);

          if (card.links !== undefined) {
            if (!Array.isArray(card.links)) {
              errors.push(`${label}のリンク一覧（links）は配列である必要があります。`);
            } else {
              for (let li = 0; li < card.links.length; li++) {
                const link = card.links[li];
                const linkLabel = `${label} リンク[${li + 1}]`;
                if (!isNonArrayObject(link)) {
                  errors.push(`${linkLabel}はオブジェクトである必要があります。`);
                  continue;
                }
                if (typeof link.label !== 'string' || link.label.trim() === '' || link.label.length > 40) {
                  errors.push(`${linkLabel}のラベルは1〜40文字の文字列で指定してください。`);
                }
                const linkUrl = link.webUrl || link.url;
                checkOptionalHttpsUrl(link.url, `${linkLabel}のURL`, errors);
                checkOptionalHttpsUrl(link.webUrl, `${linkLabel}のWeb URL`, errors);
                if (!isValidHttpsUrl(linkUrl, 2000)) {
                  errors.push(`${linkLabel}のURL（url/webUrl）は有効なHTTPS URL（2000文字以内）で指定してください。`);
                }
                checkOptionalString(link.icon, 60, `${linkLabel}のアイコン`, errors);

                if (link.androidUrl !== undefined) {
                  if (typeof link.androidUrl !== 'string' || link.androidUrl.length > 2000 || isDangerousScheme(link.androidUrl)) {
                    errors.push(`${linkLabel}のAndroid URLが無効または危険なスキームです。`);
                  }
                }
                if (link.iosUrl !== undefined) {
                  if (typeof link.iosUrl !== 'string' || link.iosUrl.length > 2000 || isDangerousScheme(link.iosUrl)) {
                    errors.push(`${linkLabel}のiOS URLが無効または危険なスキームです。`);
                  }
                }
              }
            }
          }

          if (card.travelMinutesFromPrevious !== undefined && !isInteger(card.travelMinutesFromPrevious, 0, 1440)) {
            errors.push(`${label}の移動時間は0〜1440分の整数で指定してください。`);
          }

          if (card.notifyBeforeMinutes !== undefined) {
            if (!Array.isArray(card.notifyBeforeMinutes)) {
              errors.push(`${label}の通知設定（notifyBeforeMinutes）は配列である必要があります。`);
            } else {
              for (const n of card.notifyBeforeMinutes) {
                if (!isInteger(n, 0, 10080)) {
                  errors.push(`${label}の通知分数は0〜10080分の整数で指定してください。`);
                }
              }
            }
          }

          if (card.reservation !== undefined) {
            if (!isNonArrayObject(card.reservation)) {
              errors.push(`${label}の予約情報（reservation）はオブジェクトである必要があります。`);
            } else {
              checkOptionalString(card.reservation.number, 120, `${label}の予約番号`, errors);
              checkOptionalString(card.reservation.name, 120, `${label}の予約名`, errors);
              checkOptionalString(card.reservation.phone, 40, `${label}の予約電話番号`, errors);
              checkOptionalString(card.reservation.deadline, 40, `${label}の予約期限`, errors);
              checkOptionalString(card.reservation.note, 240, `${label}の予約メモ`, errors);
              checkOptionalHttpsUrl(card.reservation.url, `${label}の予約URL`, errors);
            }
          }

          if (card.constraints !== undefined) {
            if (!isNonArrayObject(card.constraints)) {
              errors.push(`${label}の制約情報（constraints）はオブジェクトである必要があります。`);
            } else {
              for (const tf of ['opensAt', 'closesAt', 'reservationAt', 'lastEntryAt', 'departureBy']) {
                const tval = card.constraints[tf];
                if (tval !== undefined && tval !== '' && !isValidHHmm(tval)) {
                  errors.push(`${label}の${tf}はHH:mm形式で指定してください。`);
                }
              }
              if (card.constraints.arrivalBufferMinutes !== undefined && !isInteger(card.constraints.arrivalBufferMinutes, 0, 360)) {
                errors.push(`${label}の到着バッファは0〜360分の整数で指定してください。`);
              }
            }
          }

          if (card.timeLocked !== undefined && typeof card.timeLocked !== 'boolean') {
            errors.push(`${label}の固定設定（timeLocked）は真偽値で指定してください。`);
          }
        }
      }
    }
  }

  if (t.dayLabels !== undefined) {
    if (!isNonArrayObject(t.dayLabels)) {
      errors.push('日程ラベル（dayLabels）はオブジェクトである必要があります。');
    } else {
      for (const [k, v] of Object.entries(t.dayLabels)) {
        checkOptionalString(v, 80, `日程ラベル[${k}]`, errors);
      }
    }
  }

  if (t.daySettings !== undefined) {
    if (!isNonArrayObject(t.daySettings)) {
      errors.push('日程設定（daySettings）はオブジェクトである必要があります。');
    } else {
      for (const [dk, ds] of Object.entries(t.daySettings)) {
        if (!/^day\d+$/.test(dk)) {
          errors.push(`日程設定キー「${dk}」の形式が不正です。`);
        }
        if (!isNonArrayObject(ds)) {
          errors.push(`日程設定[${dk}]はオブジェクトである必要があります。`);
        } else {
          checkOptionalString(ds.note, 160, `日程設定[${dk}]のメモ`, errors);
          if (ds.departureTime !== undefined && ds.departureTime !== '' && !isValidHHmm(ds.departureTime)) {
            errors.push(`日程設定[${dk}]の出発時刻はHH:mm形式で指定してください。`);
          }
        }
      }
    }
  }

  if (t.theme !== undefined && !isNonArrayObject(t.theme)) {
    errors.push('テーマ設定（theme）はオブジェクトである必要があります。');
  }
  if (t.features !== undefined && !isNonArrayObject(t.features)) {
    errors.push('機能設定（features）はオブジェクトである必要があります。');
  }
  if (isNonArrayObject(t.theme)) {
    if (t.theme.mode !== undefined && !['auto','light','dark'].includes(t.theme.mode)) errors.push('テーマの表示モードが不正です。');
    if (t.theme.accent !== undefined && (typeof t.theme.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.theme.accent))) errors.push('テーマ色は#RRGGBB形式で指定してください。');
  }
  if (isNonArrayObject(t.features)) for (const [key,value] of Object.entries(t.features)) if (typeof value !== 'boolean') errors.push(`機能設定「${key}」は真偽値で指定してください。`);
  if (t.weatherLocations !== undefined && !isNonArrayObject(t.weatherLocations)) {
    errors.push('天気地域設定（weatherLocations）はオブジェクトである必要があります。');
  }
  if (t.checklist !== undefined && !Array.isArray(t.checklist)) {
    errors.push('チェックリスト（checklist）は配列である必要があります。');
  }

  return errors;
}

export function validateStoredDraftSize(input) {
  const errors = [];
  if (!isNonArrayObject(input)) {
    return ['下書きサイズ検証の入力が不正です。'];
  }
  const { payloadJson, planningJson } = input;
  if (typeof payloadJson !== 'string') {
    errors.push('payloadJsonは文字列である必要があります。');
  }
  if (typeof planningJson !== 'string') {
    errors.push('planningJsonは文字列である必要があります。');
  }
  if (errors.length > 0) {
    return errors;
  }

  const jsonStr = JSON.stringify({ payloadJson, planningJson });
  const byteLength = new TextEncoder().encode(jsonStr).length;
  if (byteLength > 900000) {
    errors.push(`下書きのデータサイズ（${byteLength}バイト）がFirestoreの安全上限（900,000バイト）を超えています。`);
  }
  return errors;
}
