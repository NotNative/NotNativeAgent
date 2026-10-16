// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { ReviewModeControl } from '../../../chat/review-mode-control.tsx';
import { useGlobalSessionsStore, useGlobalSessionStatusStore } from '../../../sync/global-stores.ts';
import { useAgentConfiguration } from './use-agent-configuration.ts';
import { AgentSettingsEditor } from './agent-settings-editor.tsx';
import { useSettingsLeave } from '../edit-boundary.tsx';

function ConversationReviewSettings(): ReactNode {
  const sessions = useGlobalSessionsStore(state => state.active);
  const status = useGlobalSessionStatusStore(state => state.statusById);
  const [selected, setSelected] = useState('');
  const roots = sessions.filter(session => !session.parentID);
  const session = roots.find(row => row.id === selected);
  return <section className="space-y-3 rounded-lg border border-border/60 p-4" data-settings-item="agent.review">
    <h3 className="text-sm font-medium">Conversation review policy</h3>
    <p className="text-xs text-muted-foreground">Review is mandatory in every mode. Auto-review can ask for a decision; Unattended denies unresolved escalations.
      Choose the policy in the new conversation composer, or select an existing conversation here. Changes apply only to that idle conversation.</p>
    <label className="block text-xs">Conversation<select aria-label="Conversation to configure" className="ml-3 max-w-full rounded border border-border bg-background p-2"
      value={session ? selected : ''} onChange={event => setSelected(event.target.value)}><option value="">Choose a conversation</option>
      {roots.map(row => <option key={row.id} value={row.id}>{row.title} · {row.directory}</option>)}</select></label>
    {session ? <ReviewModeControl key={session.id} sessionID={session.id} busy={status[session.id]?.type !== undefined && status[session.id]?.type !== 'idle'} /> : null}
    {!roots.length ? <p className="text-xs text-muted-foreground">No active conversations. Start one from the sidebar.</p> : null}
  </section>;
}

export function AgentSettingsPage({ page }: { page: 'agent-policy' | 'agent-context' }): ReactNode {
  const leave = useSettingsLeave();
  const state = useAgentConfiguration();
  const policy = page === 'agent-policy';
  return <div className="space-y-5" data-testid={page}>
    <header className="space-y-2"><h2 className="text-lg font-semibold">{policy ? 'Agent policy' : 'Memory and context'}</h2>
      <p className="text-xs text-muted-foreground">Scope: user configuration, resolved with the service workspace sources. Project overrides can take precedence.
        Saving does not change running engines. Restart NNA to load these defaults when engines are constructed, including reopened conversations.</p>
      <button type="button" disabled={state.loading || !state.authorized} className="rounded border border-border px-3 py-2 text-xs"
        onClick={() => leave(() => { void state.load(); })}>Reload values</button>
    </header>
    {!state.authorized ? <p role="alert">Reconnect to NNA before editing settings.</p> : null}
    {state.loading ? <p role="status">Loading native settings…</p> : null}
    {state.error ? <p role="alert">Could not load native settings. Reload values to retry.</p> : null}
    {policy ? <ConversationReviewSettings /> : <ContextSources />}
    {state.view ? <AgentSettingsEditor key={`${state.view.installation_id}:${state.view.data_id}:${state.view.source_revision}:${state.view.resolution_revision}`}
      view={state.view} groups={policy ? ['policy'] : ['context', 'memory']} onReload={() => { void state.load(); }} /> : null}
    {policy ? <section className="rounded-lg border border-border/60 p-4 text-xs" data-settings-item="agent.delegation">
      <h3 className="mb-2 text-sm font-medium">Delegated work</h3>
      <p>NNA runs foreground subagents with mandatory review, inherited scope, durable lineage, and parent cancellation.
        Subagents cannot launch nested subagents. The native agent_run tool has a one-hour timeout and a 2 MiB output ceiling.</p>
      <p className="mt-2 text-muted-foreground">These are runtime rules, not editable preferences. Configure the subagent model in Providers and models → Routing.</p>
    </section> : null}
  </div>;
}

function ContextSources(): ReactNode {
  return <section className="rounded-lg border border-border/60 p-4 text-xs" data-settings-item="agent.sources">
    <h3 className="mb-2 text-sm font-medium">Instructions and memory sources</h3>
    <p>AGENTS.md supplies instructions for its directory and descendants; closer files take precedence.
      NNA.md supplies optional local project memory. Application instructions are configured in Agent policy.</p>
    <p className="mt-2 text-muted-foreground">Retrieved memory and file content cannot grant permissions or override authenticated authority.
      Optional memory retrieval below is separate from local project files. These controls do not delete memory or execution evidence.</p>
  </section>;
}
