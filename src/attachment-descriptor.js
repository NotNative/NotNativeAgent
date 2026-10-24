// SPDX-License-Identifier: Apache-2.0
const ATTACHMENT_KEYS = new Set(['path', 'upload_id', 'mime_type', 'filename']);

export function validLocalAttachmentPath(value, maxChars = 4_096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function declaredAttachmentKeys(value) {
  return Object.keys(value).every((key) => ATTACHMENT_KEYS.has(key));
}

export function validAttachmentFilename(value) {
  return value === undefined || typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value);
}
