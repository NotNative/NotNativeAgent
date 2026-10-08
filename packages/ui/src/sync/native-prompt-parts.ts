// SPDX-License-Identifier: Apache-2.0
import { harnessClient } from '../lib/nnd/client.ts';
import type { PromptPartInput } from '../lib/nnd/types.ts';

type Part = { type: 'text'; text: string; synthetic?: boolean; systemContext?: string }
  | { type: 'file'; url?: string; mime?: string; filename?: string };

/** Native prompts refer to session-owned uploads; browser data URLs never enter prompt bodies. */
export async function promptWireParts(sessionID: string, directory: string, messageID: string,
  source: Part[], nativeUploads: boolean): Promise<PromptPartInput[]> {
  const parts: PromptPartInput[] = [];
  for (const [index, part] of source.entries()) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text, ...(part.synthetic ? { synthetic: true } : {}),
        ...(part.systemContext ? { systemContext: part.systemContext } : {}) });
    } else if (nativeUploads) {
      const upload = await harnessClient.uploadAttachment(sessionID, {
        upload_id: `${messageID}_${index}`, filename: part.filename ?? 'attachment',
        mime_type: part.mime ?? 'application/octet-stream', data_url: part.url ?? '',
      }, { directory });
      if (upload.error || upload.response?.status !== 201) {
        throw Object.assign(new Error(upload.error ?? `attachment upload unexpected status ${upload.response?.status}`),
          { status: upload.response?.status, transportTagged: upload.response === undefined });
      }
      parts.push({ type: 'file', upload_id: upload.data?.upload_id ?? `${messageID}_${index}` });
    } else {
      parts.push({ type: 'file', url: part.url ?? '', mime: part.mime ?? 'application/octet-stream', filename: part.filename });
    }
  }
  return parts;
}
