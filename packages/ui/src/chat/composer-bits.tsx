// SPDX-License-Identifier: Apache-2.0
/**
 * Composer presentational pieces (P3a v1) — footer controls, attachment
 * citation chips, and the autocomplete popup. Kept separate so the composer
 * orchestrator stays under the GUI matrix caps (ADR 0017).
 */
import type { ReactNode } from 'react';
import type { AutocompleteTrigger } from './prompt-language.ts';
import type { DraftAttachment } from './drafts.ts';

export function AttachmentChips({ attachments, onRemove }: { attachments: DraftAttachment[]; onRemove: (next: DraftAttachment[]) => void }): ReactNode {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-1 pt-1" data-testid="composer-attachments">
      {attachments.map((a) => (
        <span key={a.name} className="rounded bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">[{a.name}]
          <button type="button" aria-label={`Remove ${a.name}`} className="ml-1 text-neutral-500 hover:text-white" onClick={() => onRemove(attachments.filter((x) => x.name !== a.name))}>×</button>
        </span>
      ))}
    </div>
  );
}

export function PickerPopup({ picker }: { picker: { trigger: AutocompleteTrigger; items: string[]; insert: (item: string) => void } | null }): ReactNode {
  if (!picker) return null;
  return (
    <div className="absolute bottom-full left-2 z-10 max-h-64 w-72 overflow-auto rounded-lg border border-white/10 bg-neutral-950 shadow-xl" data-testid="composer-picker">
      {picker.items.length === 0
        ? <div className="px-3 py-2 text-[11px] text-neutral-600">No matches</div>
        : picker.items.map((item) => (
            <button key={item} type="button" onClick={() => picker.insert(item)} className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/5">
              {item}
            </button>
          ))}
    </div>
  );
}

export interface ComposerFooterProps {
  busy: boolean;
  canSend: boolean;
  autoAccept: boolean;
  onAutoAccept: () => void;
  onStop: () => void;
  agent: string;
  agents: string[];
  onAgent: (agent: string) => void;
  onFiles: (files: FileList) => void;
}

export function ComposerFooter(props: ComposerFooterProps): ReactNode {
  return (
    <div className="flex items-center justify-between px-1 pb-1">
      <div className="flex items-center gap-2 text-[11px] text-neutral-500">
        <span>mock · mock-smart</span>
        <select aria-label="Agent persona" value={props.agent} onChange={(event) => props.onAgent(event.target.value)} className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-indigo-300">
          {props.agents.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <label className="cursor-pointer rounded px-2 py-1 text-[11px] text-neutral-400 hover:text-neutral-200" title="Add attachment">
          +
          <input type="file" multiple className="hidden" onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) props.onFiles(event.target.files);
            event.target.value = '';
          }} />
        </label>
        <button type="button" aria-pressed={props.autoAccept} aria-label={props.autoAccept ? 'Disable permission auto-accept' : 'Enable permission auto-accept'}
          className={`rounded px-2 py-1 text-[11px] ${props.autoAccept ? 'bg-sky-600/25 text-sky-300' : 'text-neutral-500 hover:text-neutral-200'}`}
          onClick={props.onAutoAccept}>
          auto-accept: {props.autoAccept ? 'on' : 'off'}
        </button>
        {props.busy ? (
          <button type="button" aria-label="Stop generating" className="rounded px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10" onClick={props.onStop}>
            stop
          </button>
        ) : null}
        <button type="submit" disabled={!props.canSend} aria-label="Send message" className="rounded bg-white/90 px-3 py-1.5 text-[11px] font-medium text-black disabled:opacity-40">
          send
        </button>
      </div>
    </div>
  );
}
