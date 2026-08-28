import { resolveMapFields, validateMapFields } from './map-links.js';

function isNonArrayObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function checkOptionalString(val, maxLen, label, errors) {
  if (val === undefined) return;
  if (typeof val !== 'string') {
    errors.push(`${label}は文字列で指定してください。`);
  } else if (val.length > maxLen) {
    errors.push(`${label}は${maxLen}文字以内で指定してください。`);
  }
}

const VALID_STATUSES = new Set(['open', 'adopted', 'declined', 'withdrawn']);

export function validateSuggestionInput(s) {
  const errors = [];
  if (!isNonArrayObject(s)) {
    return ['提案データはオブジェクトである必要があります。'];
  }

  // 必須項目
  if (typeof s.title !== 'string' || s.title.trim() === '') {
    errors.push('スポット名称（title）は必須です。');
  } else if (s.title.length > 120) {
    errors.push('スポット名称（title）は120文字以内で指定してください。');
  }

  if (typeof s.creatorUid !== 'string' || s.creatorUid.trim() === '') {
    errors.push('投稿者UID（creatorUid）は必須です。');
  } else if (s.creatorUid.length > 128) {
    errors.push('投稿者UID（creatorUid）は128文字以内で指定してください。');
  }

  if (typeof s.creatorName !== 'string' || s.creatorName.trim() === '') {
    errors.push('投稿者名（creatorName）は必須です。');
  } else if (s.creatorName.length > 40) {
    errors.push('投稿者名（creatorName）は40文字以内で指定してください。');
  }

  // オプショナル項目
  checkOptionalString(s.id, 80, '提案ID（id）', errors);
  if (s.id !== undefined && s.id !== '') {
    if (!/^[a-z0-9][a-z0-9_-]{3,79}$/i.test(s.id)) {
      errors.push('提案IDの形式が不正です（半角英数字・ハイフン・アンダースコア4〜80文字）。');
    }
  }

  checkOptionalString(s.comment, 200, 'ひとこと（comment）', errors);
  checkOptionalString(s.createdAt, 40, '作成日時（createdAt）', errors);
  checkOptionalString(s.updatedAt, 40, '更新日時（updatedAt）', errors);

  if (s.status !== undefined && !VALID_STATUSES.has(s.status)) {
    errors.push('提案のステータス（status）が不正です。');
  }

  // Mapフィールド検証
  errors.push(...validateMapFields(s, { allowLegacy: false }));

  // likesの検証
  if (s.likes !== undefined) {
    if (!isNonArrayObject(s.likes)) {
      errors.push('行きたいリアクション（likes）はオブジェクトで指定してください。');
    } else {
      const entries = Object.entries(s.likes);
      if (entries.length > 50) {
        errors.push('行きたいリアクション（likes）の上限（50件）を超えています。');
      }
      for (const [uid, item] of entries) {
        if (typeof uid !== 'string' || uid.trim() === '' || uid.length > 128) {
          errors.push('リアクションUIDが不正です。');
        }
        if (!isNonArrayObject(item)) {
          errors.push('リアクション項目はオブジェクトである必要があります。');
        } else {
          if (typeof item.name !== 'string' || item.name.trim() === '' || item.name.length > 40) {
            errors.push('リアクションユーザー名が不正です。');
          }
          checkOptionalString(item.at, 40, 'リアクション日時（at）', errors);
          for (const k of Object.keys(item)) {
            if (!['name', 'at'].includes(k)) {
              errors.push(`リアクション項目に未対応の項目「${k}」があります。`);
            }
          }
        }
      }
    }
  }

  // 未知フィールドの拒否
  const allowedKeys = new Set([
    'id', 'title', 'mapQuery', 'mapUrl', 'comment',
    'creatorUid', 'creatorName', 'status', 'likes',
    'createdAt', 'updatedAt'
  ]);
  for (const key of Object.keys(s)) {
    if (!allowedKeys.has(key)) {
      errors.push(`未対応の提案項目「${key}」があります。`);
    }
  }

  return errors;
}

export function validateSuggestionCommentInput(c) {
  const errors = [];
  if (!isNonArrayObject(c)) {
    return ['コメントデータはオブジェクトである必要があります。'];
  }

  checkOptionalString(c.id, 80, 'コメントID（id）', errors);
  if (c.id !== undefined && c.id !== '') {
    if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{3,79}$/i.test(c.id)) {
      errors.push('コメントIDの形式が不正です（半角英数字・ハイフン・アンダースコア4〜80文字）。');
    }
  }

  if (typeof c.suggestionId !== 'string' || c.suggestionId.trim() === '') {
    errors.push('親提案ID（suggestionId）は必須です。');
  } else if (c.suggestionId.length > 80) {
    errors.push('親提案ID（suggestionId）は80文字以内で指定してください。');
  }

  if (typeof c.text !== 'string' || c.text.trim() === '') {
    errors.push('コメント本文（text）は必須です。');
  } else if (c.text.length > 200) {
    errors.push('コメント本文（text）は200文字以内で指定してください。');
  }

  if (typeof c.creatorUid !== 'string' || c.creatorUid.trim() === '') {
    errors.push('投稿者UID（creatorUid）は必須です。');
  } else if (c.creatorUid.length > 128) {
    errors.push('投稿者UID（creatorUid）は128文字以内で指定してください。');
  }

  if (typeof c.creatorName !== 'string' || c.creatorName.trim() === '') {
    errors.push('投稿者名（creatorName）は必須です。');
  } else if (c.creatorName.length > 40) {
    errors.push('投稿者名（creatorName）は40文字以内で指定してください。');
  }

  checkOptionalString(c.createdAt, 40, '作成日時（createdAt）', errors);

  const allowedKeys = new Set(['id', 'suggestionId', 'text', 'creatorUid', 'creatorName', 'createdAt']);
  for (const key of Object.keys(c)) {
    if (!allowedKeys.has(key)) {
      errors.push(`未対応のコメント項目「${key}」があります。`);
    }
  }

  return errors;
}

export function validateSuggestionLikeAction(action) {
  const errors = [];
  if (!isNonArrayObject(action)) {
    return ['リアクション操作はオブジェクトである必要があります。'];
  }
  if (typeof action.uid !== 'string' || action.uid.trim() === '' || action.uid.length > 128) {
    errors.push('操作者UID（uid）が不正です。');
  }
  if (typeof action.desired !== 'boolean') {
    errors.push('リアクション希望状態（desired: boolean）を指定してください。');
  }
  if (action.desired && (typeof action.name !== 'string' || action.name.trim() === '' || action.name.length > 40)) {
    errors.push('リアクション追加時は表示名（name: 1〜40文字）が必要です。');
  }
  for (const k of Object.keys(action)) {
    if (!['uid', 'desired', 'name'].includes(k)) {
      errors.push(`未対応の操作項目「${k}」があります。`);
    }
  }
  return errors;
}

export function cleanSuggestion(raw) {
  if (!isNonArrayObject(raw)) return null;
  const title = String(raw.title || '').trim().slice(0, 120);
  const creatorUid = String(raw.creatorUid || '').trim().slice(0, 128);
  const creatorName = String(raw.creatorName || '').trim().slice(0, 40);
  if (!title || !creatorUid || !creatorName) return null;

  const existingId = String(raw.id || '').trim();
  const id = /^[a-z0-9][a-z0-9_-]{3,79}$/i.test(existingId)
    ? existingId
    : `sug-${globalThis.crypto.randomUUID()}`;

  const status = VALID_STATUSES.has(raw.status) ? raw.status : 'open';
  const comment = String(raw.comment || '').trim().slice(0, 200);
  const { mapQuery, mapUrl } = resolveMapFields(raw);
  const createdAt = String(raw.createdAt || '').trim().slice(0, 40) || new Date().toISOString();
  const updatedAt = String(raw.updatedAt || '').trim().slice(0, 40) || createdAt;

  const cleaned = {
    id,
    title,
    creatorUid,
    creatorName,
    status,
    createdAt,
    updatedAt
  };

  if (comment) cleaned.comment = comment;
  if (mapQuery) cleaned.mapQuery = mapQuery;
  if (mapUrl) cleaned.mapUrl = mapUrl;

  if (isNonArrayObject(raw.likes)) {
    const cleanedLikes = {};
    const entries = Object.entries(raw.likes).slice(0, 50);
    for (const [uid, item] of entries) {
      if (typeof uid === 'string' && uid.trim() && isNonArrayObject(item) && typeof item.name === 'string' && item.name.trim()) {
        cleanedLikes[uid.trim().slice(0, 128)] = {
          name: item.name.trim().slice(0, 40),
          at: String(item.at || '').trim().slice(0, 40) || new Date().toISOString()
        };
      }
    }
    cleaned.likes = cleanedLikes;
  } else {
    cleaned.likes = {};
  }

  return cleaned;
}

export function cleanSuggestionComment(raw) {
  if (!isNonArrayObject(raw)) return null;
  const suggestionId = String(raw.suggestionId || '').trim().slice(0, 80);
  const text = String(raw.text || '').trim().slice(0, 200);
  const creatorUid = String(raw.creatorUid || '').trim().slice(0, 128);
  const creatorName = String(raw.creatorName || '').trim().slice(0, 40);
  if (!suggestionId || !text || !creatorUid || !creatorName) return null;

  const existingId = String(raw.id || '').trim();
  const id = /^[a-z0-9][a-z0-9_-]{3,79}$/i.test(existingId)
    ? existingId
    : `com-${globalThis.crypto.randomUUID()}`;

  const createdAt = String(raw.createdAt || '').trim().slice(0, 40) || new Date().toISOString();

  return {
    id,
    suggestionId,
    text,
    creatorUid,
    creatorName,
    createdAt
  };
}
