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

export function ChatPage(): ReactNode {
  const { t } = useI18n();
  const renderModes = [
    { value: 'sorted', label: t('settings.chat.sorted') },
    { value: 'live', label: t('settings.chat.live') },
  ];
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
  const recapEnabled = useSettingsField<boolean>('sessionRecapEnabled');
  const suggestionEnabled = useSettingsField<boolean>('sessionSuggestionEnabled');
  const goalEnabled = useSettingsField<boolean>('sessionGoalEnabled');
  const goalBudgetDefault = useSettingsField<boolean>('sessionGoalDefaultBudgetEnabled');
  const goalBudget = useSettingsField<number>('sessionGoalDefaultBudget');

  const yes = (value: boolean | undefined, fallback: boolean): boolean => value ?? fallback;

  return (
    <div className="flex flex-col gap-3">
      <SettingsSection title={t('settings.chat.rendering')}>
        <SettingsFieldRow label={t('settings.search.renderMode')} item="chat.render-mode">
          <SettingsRadioGroup value={chatRenderMode.value ?? 'live'} options={renderModes} onChange={(value) => chatRenderMode.set(value as 'sorted' | 'live')} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.activityRender')} item="chat.activity-default">
          <SettingsRadioGroup value={activity.value ?? 'collapsed'} options={[{ value: 'collapsed', label: t('settings.chat.collapsed') }, { value: 'summary', label: t('settings.chat.summary') }]} onChange={(value) => activity.set(value as 'collapsed' | 'summary')} />
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
            options={[{ value: 'markdown', label: t('settings.chat.markdown') }, { value: 'plain', label: t('settings.chat.plainText') }]}
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

      <SettingsSection title={t('settings.chat.composerHistory')} item="chat.composer">
        <SettingsFieldRow label={t('settings.search.followUp')} item="chat.follow-up">
          <SettingsSelect
            value={followUp.value ?? 'steer'}
            resetValue="steer"
            onChange={(value) => followUp.set(value as 'steer' | 'queue')}
            options={[{ value: 'steer', label: 'Steer in-flight turn' }, { value: 'queue', label: 'Queue follow-ups' }]}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.chat.composerInputHistory')} item="chat.input-history" helper="1..100 messages, default 40">
          <SettingsSelect
            value={historyScope.value ?? 'session'}
            resetValue="session"
            onChange={(value) => historyScope.set(value as 'global' | 'session')}
            options={[{ value: 'session', label: t('settings.chat.perSession') }, { value: 'global', label: t('settings.chat.allSessions') }]}
          />
          <SettingsNumberInput value={historyLimit.value ?? 40} min={1} max={100} step={1} unit="messages" resetValue={40} onChange={historyLimit.set} />
        </SettingsFieldRow>
        <SettingsCheckboxRow label={t('settings.chat.persistDraft')} item="chat.composer-draft" checked={yes(persistDraft.value, true)} onChange={persistDraft.set} />
        <SettingsCheckboxRow label={t('settings.chat.spellcheck')} item="chat.composer-spellcheck" checked={yes(spellcheck.value, true)} onChange={spellcheck.set} />
        <SettingsFieldRow label={t('settings.chat.largeTextPaste')} item="chat.composer-large-paste">
          <SettingsSelect
            value={largeTextPaste.value ?? 'ask'}
            resetValue="ask"
            onChange={(value) => largeTextPaste.set(value as 'ask' | 'attach' | 'inline')}
            options={[{ value: 'ask', label: t('settings.chat.askLargePaste') }, { value: 'attach', label: t('settings.chat.attachAsFile') }, { value: 'inline', label: t('settings.chat.pasteInline') }]}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.chat.enterKeySends')} item="chat.composer-enter">
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
              { value: 'unset', label: t('settings.chat.platformDefault') },
              { value: 'enter', label: t('settings.chat.enterSends') },
              { value: 'cmdEnter', label: t('settings.chat.modifierEnterSends') },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t('settings.chat.reasoningStreaming')}>
        <SettingsCheckboxRow label={t('settings.search.reasoning')} item="chat.reasoning-traces" checked={yes(traces.value, false)} onChange={traces.set} />
        <SettingsCheckboxRow label={t('settings.chat.collapsibleThinking')} item="chat.reasoning-collapsible" checked={yes(collapsibleThinking.value, true)} disabled={!yes(traces.value, false)} onChange={collapsibleThinking.set} />
        <SettingsCheckboxRow label={t('settings.search.streaming')} item="chat.streaming-follow" checked={yes(autoFollow.value, true)} onChange={autoFollow.set} />
      </SettingsSection>

      <SettingsSection title={t('settings.search.messageAppearance')} item="chat.message-appearance">
        <SettingsCheckboxRow label={t('settings.chat.stickyUserHeader')} item="chat.sticky-user-header" checked={yes(stickyUserHeader.value, false)} onChange={stickyUserHeader.set} />
        <SettingsCheckboxRow label={t('settings.chat.promptNavigator')} item="chat.prompt-navigator" checked={yes(promptNavigator.value, false)} onChange={promptNavigator.set} />
        <SettingsCheckboxRow label={t('settings.chat.wideLayout')} item="chat.wide-layout" checked={yes(wideLayout.value, false)} onChange={wideLayout.set} />
        <SettingsCheckboxRow label={t('settings.chat.collapsibleUserMessages')} item="chat.collapsible-user-messages" checked={yes(collapsibleUserMessages.value, true)} onChange={collapsibleUserMessages.set} />
        <SettingsCheckboxRow label={t('settings.chat.splitActions')} item="chat.split-actions" checked={yes(splitActions.value, false)} onChange={splitActions.set} />
        <SettingsCheckboxRow label={t('settings.chat.lineWrap')} item="chat.code-line-wrap" checked={yes(lineWrap.value, false)} onChange={lineWrap.set} />
      </SettingsSection>

      <SettingsSection title={t('settings.search.toolsFiles')} item="chat.tools-and-files">
        <SettingsCheckboxRow label={t('settings.chat.showToolFileIcons')} item="chat.tool-file-icons" checked={yes(toolIcons.value, true)} onChange={toolIcons.set} />
        <SettingsCheckboxRow label={t('settings.chat.showTurnChangedFiles')} item="chat.turn-changed-files" checked={yes(changedFiles.value, true)} onChange={changedFiles.set} />
        <SettingsCheckboxRow label={t('settings.chat.showDotfiles')} item="chat.dotfiles" checked={yes(dotfiles.value, false)} onChange={dotfiles.set} />
        <SettingsCheckboxRow label={t('settings.chat.previewFilesBeforeAttach')} item="chat.file-viewer-preview" checked={yes(filePreview.value, false)} onChange={filePreview.set} />
      </SettingsSection>

      <SettingsSection title={t('settings.search.sessionAssist')} item="chat.session-assist">
        <SettingsCheckboxRow label={t('settings.chat.draftStartersVisible')} item="chat.draft-starters" checked={yes(startersVisible.value, true)} onChange={startersVisible.set} />
        <SettingsCheckboxRow label={t('settings.chat.allowPromptingSubagent')} item="chat.subagent-prompting" checked={yes(subagentPrompting.value, false)} onChange={subagentPrompting.set} />
        <SettingsCheckboxRow label={t('settings.chat.showAssistantRecaps')} item="chat.session-recap" checked={yes(recapEnabled.value, true)} onChange={recapEnabled.set} />
        <SettingsCheckboxRow label={t('settings.chat.showFollowupSuggestions')} item="chat.session-suggestion" checked={yes(suggestionEnabled.value, true)} onChange={suggestionEnabled.set} />
      </SettingsSection>

      <SettingsSection title={t('settings.search.sessionGoal')} item="chat.session-goal">
        <SettingsCheckboxRow label={t('settings.chat.enableSessionGoals')} item="chat.session-goal-enabled" checked={yes(goalEnabled.value, false)} onChange={goalEnabled.set} />
        <SettingsCheckboxRow label={t('settings.chat.defaultBudgetAllSessions')} item="chat.session-goal-default" checked={yes(goalBudgetDefault.value, false)} disabled={!yes(goalEnabled.value, false)} onChange={goalBudgetDefault.set} />
        <SettingsFieldRow label={t('settings.chat.defaultBudgetLabel')} item="chat.session-goal-budget" helper="1000..100000000 tokens (step 50000)">
          <SettingsNumberInput value={goalBudget.value ?? 50000} min={1000} max={100000000} step={50000} onChange={goalBudget.set} />
        </SettingsFieldRow>
      </SettingsSection>
    </div>
  );
}

