// SPDX-License-Identifier: Apache-2.0
/**
 * General page (doc 14 §G.3 General composition, web slice): agent tool
 * toggles, harness CLI path + restart confirm, usage-report consent. The
 * desktop/network/passkey sections render with P12/P11.
 */
import type { ReactNode } from 'react';
import {
  SettingsSection, SettingsGroupTitle, SettingsFieldRow, SettingsCheckboxRow, SettingsTextInput,
} from '../primitives.tsx';
import { useSettingsField } from '../page-helpers.tsx';
import { useI18n } from '../../I18nProvider.tsx';

export function GeneralPage(): ReactNode {
  const { t } = useI18n();
  const agentControlTool = useSettingsField<boolean>('agentControlToolEnabled');
  const agentWebTool = useSettingsField<boolean>('agentWebToolEnabled');
  const agentMemoryTool = useSettingsField<boolean>('agentMemoryToolEnabled');
  const binary = useSettingsField<string>('opencodeBinary');
  const restartConfirm = useSettingsField<boolean>('showOpenCodeRestartConfirm');
  const reportUsage = useSettingsField<boolean>('reportUsage');

  const yes = (value: boolean | undefined, fallback: boolean): boolean => value ?? fallback;

  return (
    <div className="flex flex-col gap-3">
      <SettingsSection item="general.tools">
        <SettingsGroupTitle>{t('settings.search.agentTools')}</SettingsGroupTitle>
        <SettingsCheckboxRow label="Agent control tool" item="general.tools.control" checked={yes(agentControlTool.value, true)} onChange={agentControlTool.set} />
        <SettingsCheckboxRow label="Agent web tool" item="general.tools.web" checked={yes(agentWebTool.value, true)} onChange={agentWebTool.set} />
        <SettingsCheckboxRow label="Agent memory tool" item="general.tools.memory" checked={yes(agentMemoryTool.value, true)} onChange={agentMemoryTool.set} />
      </SettingsSection>

      <SettingsSection item="general.harness">
        <SettingsGroupTitle>{t('settings.search.harnessBinary')}</SettingsGroupTitle>
        <SettingsFieldRow label="Harness CLI binary path" item="general.harness.binary" helper="Empty = harness default resolution">
          <SettingsTextInput
            value={binary.value ?? ''}
            placeholder="e.g. /usr/local/bin/notnativeagent"
            max={2048}
            onCommit={binary.set}
            resetValue=""
          />
        </SettingsFieldRow>
        <SettingsCheckboxRow label="Confirm harness restarts" item="general.harness.restart-confirm" checked={yes(restartConfirm.value, true)} onChange={restartConfirm.set} />
      </SettingsSection>

      <SettingsSection>
        <SettingsGroupTitle>{t('settings.search.reportUsage')}</SettingsGroupTitle>
        <SettingsCheckboxRow
          label="Share anonymous usage reports"
          item="general.telemetry"
          checked={yes(reportUsage.value, false)}
          helper="Telemetry consent (§§F.5 reportUsage)"
          onChange={reportUsage.set}
        />
      </SettingsSection>
    </div>
  );
}

