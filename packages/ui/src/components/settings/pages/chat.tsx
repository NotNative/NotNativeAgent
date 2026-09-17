// SPDX-License-Identifier: Apache-2.0
/**
 * Chat page (doc 14 §G.4 chat column): render modes, activity/user-message
 * rendering, diff layout, composer behavior, reasoning, streaming, message
 * appearance, tools/files, session assist + goals. VS Code-hidden rows are
 * rendered plainly here (the vscode surface does not load this build's UI).
 */
import type { ReactNode } from 'react';
import {
  SettingsSection, SettingsGroupTitle, SettingsFieldRow, SettingsRadioGroup, SettingsCheckboxRow,
  SettingsSelect, SettingsNumberInput,
} from '../primitives.tsx';
import { useSettingsField } from '../page-helpers.tsx';
import { useI18n } from '../../I18nProvider.tsx';

const RENDER_MODES = [
  { value: 'sorted', label: 'Sorted' },
  { value: 'live', label: 'Live' },
];

export function ChatPage(): ReactNode {
  const { t } = useI18n();
  const chatRenderMode = useSettingsField<'sorted' | 'live'>('chatRenderMode');
  const activity = useSettingsField<'collapsed' | 'summary'>('activityRenderMode');
  const userMessageRendering = useSettingsField<'markdown' | 'plain'>('userMessageRenderingMode');
  const mermaid = useSettingsField<'svg' | 'ascii'>('mermaidRenderingMode');
  const diffLayout = useSettingsField<'dynamic' | 'inline' | 'side-by-side'>('diffLayoutPreference');
  const followUp = useSettingsField<'steer' | 'queue'>('followUpBehavior');
  const historyScope = useSettingsField<'global' | 'session'>('inputHistoryScope');
  const historyLimit = useSettingsField<number>('inputHistoryLimit');
  const traces = useSettingsField<boolean>('showReasoningTraces');
  const collapsibleThinking = useSettingsField<boolean>('collapsibleThinkingBlocks');
  const autoFollow = useSettingsField<boolean>('streamingAutoFollowEnabled');
  const stickyUserHeader = useSettingsField<boolean>('stickyUserHeader');
  const promptNavigator = useSettingsField<boolean>('promptNavigatorEnabled');
  const wideLayout = useSettingsField<boolean>('wideChatLayoutEnabled');
  const collapsibleUserMessages = useSettingsField<boolean>('collapsibleUserMessages');
  const splitActions = useSettingsField<boolean>('showSplitAssistantMessageActions');
  const lineWrap = useSettingsField<boolean>('codeBlockLineWrap');
  const toolIcons = useSettingsField<boolean>('showToolFileIcons');
  const changedFiles = useSettingsField<boolean>('showTurnChangedFiles');
  const dotfiles = useSettingsField<boolean>('directoryShowHidden');
  const filePreview = useSettingsField<boolean>('defaultFileViewerPreview');
  const spellcheck = useSettingsField<boolean>('inputSpellcheckEnabled');
  const persistDraft = useSettingsField<boolean>('persistChatDraft');
  const largeTextPaste = useSettingsField<'ask' | 'attach' | 'inline'>('largeTextPasteBehavior');
  const enterToSend = useSettingsField<boolean>('enterToSend');
  const enterToSendConfigured = useSettingsField<boolean>('enterToSendConfigured');
  const startersVisible = useSettingsField<boolean>('draftStartersVisible');
  const subagentPrompting = useSettingsField<boolean>('allowPromptingSubagentSessions');
  const goalEnabled = useSettingsField<boolean>('sessionGoalEnabled');
  const goalBudgetDefault = useSettingsField<boolean>('sessionGoalDefaultBudgetEnabled');
  const goalBudget = useSettingsField<number>('sessionGoalDefaultBudget');

  const yes = (value: boolean | undefined, fallback: boolean): boolean => value ?? fallback;

  return (
    <div className="flex flex-col gap-3">
      <SettingsSection title="Rendering">
        <SettingsFieldRow label={t('settings.search.renderMode')} item="chat.render-mode">
          <SettingsRadioGroup value={chatRenderMode.value ?? 'live'} options={RENDER_MODES} onChange={(value) => chatRenderMode.set(value as 'sorted' | 'live')} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.activityRender')} item="chat.activity-default">
          <SettingsRadioGroup value={activity.value ?? 'collapsed'} options={[{ value: 'collapsed', label: 'Collapsed' }, { value: 'summary', label: 'Summary' }]} onChange={(value) => activity.set(value as 'collapsed' | 'summary')} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.userMessageRendering')} item="chat.user-message-rendering">
          {/*
            NOTE (chat page row contract): the §G.4 page puts this group as a
            radio; the select form factors the same field.
          */}
          <SettingsSelect
            value={userMessageRendering.value ?? 'markdown'}
            resetValue="markdown"
            onChange={(value) => userMessageRendering.set(value as 'markdown' | 'plain')}
            options={[{ value: 'markdown', label: 'Markdown' }, { value: 'plain', label: 'Plain text' }]}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.mermaid')} item="chat.mermaid">
          <SettingsRadioGroup value={mermaid.value ?? 'svg'} options={[{ value: 'svg', label: 'SVG' }, { value: 'ascii', label: 'ASCII' }]} onChange={(value) => mermaid.set(value as 'svg' | 'ascii')} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.diffLayout')} item="chat.diff-layout">
          <SettingsSelect
            value={diffLayout.value ?? 'dynamic'}
            resetValue="dynamic"
            onChange={(value) => diffLayout.set(value as 'dynamic' | 'inline' | 'side-by-side')}
            options={[
              { value: 'dynamic', label: 'Dynamic' },
              { value: 'inline', label: 'Inline' },
              { value: 'side-by-side', label: 'Side-by-side' },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title="Composer & history" item="chat.composer">
        <SettingsFieldRow label={t('settings.search.followUp')} item="chat.follow-up">
          <SettingsSelect
            value={followUp.value ?? 'steer'}
            resetValue="steer"
            onChange={(value) => followUp.set(value as 'steer' | 'queue')}
            options={[{ value: 'steer', label: 'Steer in-flight turn' }, { value: 'queue', label: 'Queue follow-ups' }]}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label="Composer input history" item="chat.input-history" helper="1..100 messages, default 40">
          <SettingsSelect
            value={historyScope.value ?? 'session'}
            resetValue="session"
            onChange={(value) => historyScope.set(value as 'global' | 'session')}
            options={[{ value: 'session', label: 'Per session' }, { value: 'global', label: 'All sessions' }]}
          />
          <SettingsNumberInput value={historyLimit.value ?? 40} min={1} max={100} step={1} unit="messages" resetValue={40} onChange={historyLimit.set} />
        </SettingsFieldRow>
        <SettingsCheckboxRow label="Persist draft between sessions" item="chat.composer-draft" checked={yes(persistDraft.value, true)} onChange={persistDraft.set} />
        <SettingsCheckboxRow label="Spellcheck in the composer" item="chat.composer-spellcheck" checked={yes(spellcheck.value, true)} onChange={spellcheck.set} />
        <SettingsFieldRow label="Large text paste" item="chat.composer-large-paste">
          <SettingsSelect
            value={largeTextPaste.value ?? 'ask'}
            resetValue="ask"
            onChange={(value) => largeTextPaste.set(value as 'ask' | 'attach' | 'inline')}
            options={[{ value: 'ask', label: 'Ask' }, { value: 'attach', label: 'Attach as file' }, { value: 'inline', label: 'Paste inline' }]}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label="Enter key sends" item="chat.composer-enter" helper="First choice writes enterToSend + the configured marker">
          <SettingsSelect
            value={yes(enterToSendConfigured.value, false) ? (yes(enterToSend.value, false) ? 'enter' : 'cmdEnter') : 'unset'}
            resetValue="unset"
            onChange={(value) => {
              if (value === 'unset') {
                enterToSendConfigured.set(false);
                enterToSend.set(false);
                return;
              }
              enterToSend.set(value === 'enter');
              enterToSendConfigured.set(true);
            }}
            options={[
              { value: 'unset', label: 'Platform default' },
              { value: 'enter', label: 'Enter sends' },
              { value: 'cmdEnter', label: 'Cmd/Ctrl+Enter sends' },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title="Reasoning & streaming">
        <SettingsCheckboxRow label={t('settings.search.reasoning')} item="chat.reasoning-traces" checked={yes(traces.value, false)} onChange={traces.set} />
        <SettingsCheckboxRow label="Collapsible thinking blocks" item="chat.reasoning-collapsible" checked={yes(collapsibleThinking.value, true)} disabled={!yes(traces.value, false)} onChange={collapsibleThinking.set} />
        <SettingsCheckboxRow label={t('settings.search.streaming')} item="chat.streaming-follow" checked={yes(autoFollow.value, true)} onChange={autoFollow.set} />
      </SettingsSection>

      <SettingsSection title="Message appearance" item="chat.message-appearance">
        <SettingsCheckboxRow label="Sticky user message header" item="chat.sticky-user-header" checked={yes(stickyUserHeader.value, false)} onChange={stickyUserHeader.set} />
        <SettingsCheckboxRow label="Prompt navigator rail" item="chat.prompt-navigator" checked={yes(promptNavigator.value, false)} onChange={promptNavigator.set} />
        <SettingsCheckboxRow label="Wide chat layout" item="chat.wide-layout" checked={yes(wideLayout.value, false)} onChange={wideLayout.set} />
        <SettingsCheckboxRow label="Collapsible user messages" item="chat.collapsible-user-messages" checked={yes(collapsibleUserMessages.value, true)} onChange={collapsibleUserMessages.set} />
        <SettingsCheckboxRow label="Per-part assistant message actions" item="chat.split-actions" checked={yes(splitActions.value, false)} onChange={splitActions.set} />
        <SettingsCheckboxRow label="Wrap long code lines" item="chat.code-line-wrap" checked={yes(lineWrap.value, false)} onChange={lineWrap.set} />
      </SettingsSection>

      <SettingsSection title="Tools & files" item="chat.tools-and-files">
        <SettingsCheckboxRow label="Show tool file icons" item="chat.tool-file-icons" checked={yes(toolIcons.value, true)} onChange={toolIcons.set} />
        <SettingsCheckboxRow label="Show turn changed files" item="chat.turn-changed-files" checked={yes(changedFiles.value, true)} onChange={changedFiles.set} />
        <SettingsCheckboxRow label="Show dotfiles in directory trees" item="chat.dotfiles" checked={yes(dotfiles.value, false)} onChange={dotfiles.set} />
        <SettingsCheckboxRow label="Preview open files before attaching" item="chat.file-viewer-preview" checked={yes(filePreview.value, false)} onChange={filePreview.set} />
      </SettingsSection>

      <SettingsSection title="Session assistance" item="chat.session-assist">
        <SettingsCheckboxRow label="Draft starters visible" item="chat.draft-starters" checked={yes(startersVisible.value, true)} onChange={startersVisible.set} />
        <SettingsCheckboxRow label="Allow prompting subagent sessions" item="chat.subagent-prompting" checked={yes(subagentPrompting.value, false)} onChange={subagentPrompting.set} />
      </SettingsSection>

      <SettingsSection title="Session goals" item="chat.session-goal">
        <SettingsCheckboxRow label={t('settings.search.sessionGoal')} item="chat.session-goal-enabled" checked={yes(goalEnabled.value, false)} onChange={goalEnabled.set} />
        <SettingsCheckboxRow label="Default budget applied to every session" item="chat.session-goal-default" checked={yes(goalBudgetDefault.value, false)} disabled={!yes(goalEnabled.value, false)} onChange={goalBudgetDefault.set} />
        <SettingsFieldRow label="Default budget" item="chat.session-goal-budget" helper="1000..100000000 tokens (step 50000)">
          <SettingsNumberInput value={goalBudget.value ?? 50000} min={1000} max={100000000} step={50000} onChange={goalBudget.set} />
        </SettingsFieldRow>
      </SettingsSection>
    </div>
  );
}

