// SPDX-License-Identifier: Apache-2.0
/**
 * Non-English catalogs (doc 14 §H.2, delta E2): P5-4 ships en complete and
 * the 11 other locales as partial catalogs — the resolve chain falls back
 * per key to en (lib/i18n/context), and the closed `I18nKey` from en.ts
 * makes impossible keys a type error. Per-locale parity is authoring work;
 * the per-locale file split (<locale>.settings.ts) lands with the settings
 * volumes that need it.
 */
import type { PartialDictionary } from './en.ts';

import { de, fr, zhCN } from './locale-catalogs-a.ts';
import { zhTW } from './locale-catalogs-d.ts';
import { uk, es } from './locale-catalogs-c.ts';
import { ptBR, ko, pl } from './locale-catalogs-b.ts';
import { ja } from './locale-catalogs-e.ts';
import { tr } from './locale-catalogs-c.ts';
import { deShortcuts, frShortcuts, zhCNShortcuts, deShortcutLabels, frShortcutLabels, zhCNShortcutLabels } from './locale-shortcuts-a.ts';
import { zhTWShortcuts, ukShortcuts, esShortcuts, ptBRShortcuts, zhTWShortcutLabels, ukShortcutLabels, esShortcutLabels, ptBRShortcutLabels } from './locale-shortcuts-b.ts';
import { koShortcuts, plShortcuts, jaShortcuts, trShortcuts, koShortcutLabels, plShortcutLabels, jaShortcutLabels, trShortcutLabels } from './locale-shortcuts-c.ts';
import { deAppearance, frAppearance, zhCNAppearance, zhTWAppearance, ukAppearance, esAppearance, ptBRAppearance, koAppearance, plAppearance, jaAppearance, trAppearance } from './locale-appearance.ts';
import { deSkillsInventory, frSkillsInventory, zhCNSkillsInventory, zhTWSkillsInventory, ukSkillsInventory, esSkillsInventory, ptBRSkillsInventory, koSkillsInventory, plSkillsInventory, jaSkillsInventory, trSkillsInventory } from './locale-skills-inventory.ts';
import { deMcpInventory, frMcpInventory, zhCNMcpInventory, zhTWMcpInventory, ukMcpInventory, esMcpInventory, ptBRMcpInventory, koMcpInventory, plMcpInventory, jaMcpInventory, trMcpInventory } from './locale-mcp-inventory.ts';
import { deMcpConfig, frMcpConfig, zhCNMcpConfig, zhTWMcpConfig, ukMcpConfig, esMcpConfig, ptBRMcpConfig, koMcpConfig, plMcpConfig, jaMcpConfig, trMcpConfig } from './locale-mcp-config.ts';
import { deMcpDraft, frMcpDraft, zhCNMcpDraft, zhTWMcpDraft, ukMcpDraft, esMcpDraft, ptBRMcpDraft, koMcpDraft, plMcpDraft, jaMcpDraft, trMcpDraft } from './locale-mcp-draft.ts';
import { deSnippets, frSnippets, zhCNSnippets, zhTWSnippets, ukSnippets, esSnippets, ptBRSnippets, koSnippets, plSnippets, jaSnippets, trSnippets } from './locale-snippets.ts';
import { deNnaRoutes, frNnaRoutes, zhCNNnaRoutes, zhTWNnaRoutes, ukNnaRoutes, esNnaRoutes, ptBRNnaRoutes, koNnaRoutes, plNnaRoutes, jaNnaRoutes, trNnaRoutes } from './locale-nna-routes.ts';
import { deProviders, frProviders, zhCNProviders, zhTWProviders, ukProviders, esProviders, ptBRProviders, koProviders, plProviders, jaProviders, trProviders } from './locale-providers.ts';
import { deDesktopSsh, frDesktopSsh, zhCNDesktopSsh, zhTWDesktopSsh, ukDesktopSsh, esDesktopSsh, ptBRDesktopSsh, koDesktopSsh, plDesktopSsh, jaDesktopSsh, trDesktopSsh } from './locale-desktop-ssh.ts';
import { deDesktopGenerals, frDesktopGenerals, zhCNDesktopGenerals, zhTWDesktopGenerals, ukDesktopGenerals, esDesktopGenerals, ptBRDesktopGenerals, koDesktopGenerals, plDesktopGenerals, jaDesktopGenerals, trDesktopGenerals } from './locale-desktop-generals.ts';
import { deRemoteInstances, frRemoteInstances, zhCNRemoteInstances, zhTWRemoteInstances, ukRemoteInstances, esRemoteInstances, ptBRRemoteInstances, koRemoteInstances, plRemoteInstances, jaRemoteInstances, trRemoteInstances } from './locale-remote-instances.ts';
import { deShellUi, frShellUi, zhCNShellUi, zhTWShellUi, ukShellUi, esShellUi, ptBRShellUi, koShellUi, plShellUi, jaShellUi, trShellUi } from './locale-shell-ui.ts';
import { deAgentGroups, frAgentGroups, zhCNAgentGroups, zhTWAgentGroups, ukAgentGroups, esAgentGroups, ptBRAgentGroups, koAgentGroups, plAgentGroups, jaAgentGroups, trAgentGroups } from './locale-agent-groups.ts';
import { deGitUi, frGitUi, zhCNGitUi, zhTWGitUi, ukGitUi, esGitUi, ptBRGitUi, koGitUi, plGitUi, jaGitUi, trGitUi } from './locale-git-ui.ts';
import { deDiffUi, frDiffUi, zhCNDiffUi, zhTWDiffUi, ukDiffUi, esDiffUi, ptBRDiffUi, koDiffUi, plDiffUi, jaDiffUi, trDiffUi } from './locale-diff-ui.ts';
import { dePairing, frPairing, zhCNPairing, zhTWPairing, ukPairing, esPairing, ptBRPairing, koPairing, plPairing, jaPairing, trPairing } from './locale-pairing.ts';
import { deScheduled, frScheduled, zhCNScheduled, zhTWScheduled, ukScheduled, esScheduled, ptBRScheduled, koScheduled, plScheduled, jaScheduled, trScheduled } from './locale-scheduled.ts';
import { deSkillsCatalog, frSkillsCatalog, zhCNSkillsCatalog, zhTWSkillsCatalog, ukSkillsCatalog, esSkillsCatalog, ptBRSkillsCatalog, koSkillsCatalog, plSkillsCatalog, jaSkillsCatalog, trSkillsCatalog } from './locale-skills-catalog.ts';
import en, { type Dictionary } from './en.ts';

const CATALOGS: Record<string, PartialDictionary> = {
  de: { ...de, ...deShortcuts, ...deShortcutLabels, ...deAppearance, ...deSkillsInventory, ...deSkillsCatalog, ...deMcpInventory, ...deMcpConfig, ...deMcpDraft, ...deSnippets, ...deNnaRoutes, ...deProviders, ...deDesktopSsh, ...deRemoteInstances, ...deDesktopGenerals, ...deShellUi, ...deAgentGroups, ...deGitUi, ...deDiffUi, ...dePairing, ...deScheduled },
  fr: { ...fr, ...frShortcuts, ...frShortcutLabels, ...frAppearance, ...frSkillsInventory, ...frSkillsCatalog, ...frMcpInventory, ...frMcpConfig, ...frMcpDraft, ...frSnippets, ...frNnaRoutes, ...frProviders, ...frDesktopSsh, ...frRemoteInstances, ...frDesktopGenerals, ...frShellUi, ...frAgentGroups, ...frGitUi, ...frDiffUi, ...frPairing, ...frScheduled },
  'zh-CN': { ...zhCN, ...zhCNShortcuts, ...zhCNShortcutLabels, ...zhCNAppearance, ...zhCNSkillsInventory, ...zhCNSkillsCatalog, ...zhCNMcpInventory, ...zhCNMcpConfig, ...zhCNMcpDraft, ...zhCNSnippets, ...zhCNNnaRoutes, ...zhCNProviders, ...zhCNDesktopSsh, ...zhCNRemoteInstances, ...zhCNDesktopGenerals, ...zhCNShellUi, ...zhCNAgentGroups, ...zhCNGitUi, ...zhCNDiffUi, ...zhCNPairing, ...zhCNScheduled },
  'zh-TW': { ...zhTW, ...zhTWShortcuts, ...zhTWShortcutLabels, ...zhTWAppearance, ...zhTWSkillsInventory, ...zhTWSkillsCatalog, ...zhTWMcpInventory, ...zhTWMcpConfig, ...zhTWMcpDraft, ...zhTWSnippets, ...zhTWNnaRoutes, ...zhTWProviders, ...zhTWDesktopSsh, ...zhTWRemoteInstances, ...zhTWDesktopGenerals, ...zhTWShellUi, ...zhTWAgentGroups, ...zhTWGitUi, ...zhTWDiffUi, ...zhTWPairing, ...zhTWScheduled },
  uk: { ...uk, ...ukShortcuts, ...ukShortcutLabels, ...ukAppearance, ...ukSkillsInventory, ...ukSkillsCatalog, ...ukMcpInventory, ...ukMcpConfig, ...ukMcpDraft, ...ukSnippets, ...ukNnaRoutes, ...ukProviders, ...ukDesktopSsh, ...ukRemoteInstances, ...ukDesktopGenerals, ...ukShellUi, ...ukAgentGroups, ...ukGitUi, ...ukDiffUi, ...ukPairing, ...ukScheduled },
  es: { ...es, ...esShortcuts, ...esShortcutLabels, ...esAppearance, ...esSkillsInventory, ...esSkillsCatalog, ...esMcpInventory, ...esMcpConfig, ...esMcpDraft, ...esSnippets, ...esNnaRoutes, ...esProviders, ...esDesktopSsh, ...esRemoteInstances, ...esDesktopGenerals, ...esShellUi, ...esAgentGroups, ...esGitUi, ...esDiffUi, ...esPairing, ...esScheduled },
  'pt-BR': { ...ptBR, ...ptBRShortcuts, ...ptBRShortcutLabels, ...ptBRAppearance, ...ptBRSkillsInventory, ...ptBRSkillsCatalog, ...ptBRMcpInventory, ...ptBRMcpConfig, ...ptBRMcpDraft, ...ptBRSnippets, ...ptBRNnaRoutes, ...ptBRProviders, ...ptBRDesktopSsh, ...ptBRRemoteInstances, ...ptBRDesktopGenerals, ...ptBRShellUi, ...ptBRAgentGroups, ...ptBRGitUi, ...ptBRDiffUi, ...ptBRPairing, ...ptBRScheduled },
  ko: { ...ko, ...koShortcuts, ...koShortcutLabels, ...koAppearance, ...koSkillsInventory, ...koSkillsCatalog, ...koMcpInventory, ...koMcpConfig, ...koMcpDraft, ...koSnippets, ...koNnaRoutes, ...koProviders, ...koDesktopSsh, ...koRemoteInstances, ...koDesktopGenerals, ...koShellUi, ...koAgentGroups, ...koGitUi, ...koDiffUi, ...koPairing, ...koScheduled },
  pl: { ...pl, ...plShortcuts, ...plShortcutLabels, ...plAppearance, ...plSkillsInventory, ...plSkillsCatalog, ...plMcpInventory, ...plMcpConfig, ...plMcpDraft, ...plSnippets, ...plNnaRoutes, ...plProviders, ...plDesktopSsh, ...plRemoteInstances, ...plDesktopGenerals, ...plShellUi, ...plAgentGroups, ...plGitUi, ...plDiffUi, ...plPairing, ...plScheduled },
  ja: { ...ja, ...jaShortcuts, ...jaShortcutLabels, ...jaAppearance, ...jaSkillsInventory, ...jaSkillsCatalog, ...jaMcpInventory, ...jaMcpConfig, ...jaMcpDraft, ...jaSnippets, ...jaNnaRoutes, ...jaProviders, ...jaDesktopSsh, ...jaRemoteInstances, ...jaDesktopGenerals, ...jaShellUi, ...jaAgentGroups, ...jaGitUi, ...jaDiffUi, ...jaPairing, ...jaScheduled },
  tr: { ...tr, ...trShortcuts, ...trShortcutLabels, ...trAppearance, ...trSkillsInventory, ...trSkillsCatalog, ...trMcpInventory, ...trMcpConfig, ...trMcpDraft, ...trSnippets, ...trNnaRoutes, ...trProviders, ...trDesktopSsh, ...trRemoteInstances, ...trDesktopGenerals, ...trShellUi, ...trAgentGroups, ...trGitUi, ...trDiffUi, ...trPairing, ...trScheduled },
};

/** Full dictionaries: en complete, others merged over en per §H.2 resolve. */
export function dictionaryFor(locale: string): Dictionary {
  if (locale === 'en') return en;
  return { ...en, ...(CATALOGS[locale] ?? {}) };
}

export const PARTIAL_CATALOGS = CATALOGS;
