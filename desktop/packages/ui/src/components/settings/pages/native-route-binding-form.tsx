// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import type { NativeConfigurationView, NativeValue } from '../../../lib/nnd/configuration.ts';
import type { NativeRouteRole } from '../../../lib/nnd/configuration-mutation.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { previewNativeRouteBinding, publishNativeField } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, type ControlsModel } from './native-configuration-controls-model.ts';

function value(input: NativeValue | undefined): string | null {
  return input?.present && 'value' in input && typeof input.value === 'string' ? input.value : null;
}
function userProviders(view: NativeConfigurationView): { id: string; model: string }[] {
  const result = new Map<string, string>();
  for (const row of view.fields) {
    if (!/^providers\[[A-Za-z0-9_-]{1,64}\]\.id$/u.test(row.path) || !row.explicit.present) continue;
    const id = value(row.effective);
    if (id && /^[A-Za-z0-9_-]{1,64}$/u.test(id)) {
      const model = value(view.fields.find(item => item.path === `providers[${id}].model`)?.effective);
      result.set(id, model ?? '');
    }
  }
  if (view.fields.some(row => row.path === 'provider.endpoint' && row.explicit.present)) {
    const id = value(view.fields.find(row => row.path === 'provider.id')?.effective);
    if (id && /^[A-Za-z0-9_-]{1,64}$/u.test(id)) {
      result.set(id, value(view.fields.find(row => row.path === 'provider.model')?.effective) ?? '');
    }
  }
  return [...result].map(([id, model]) => ({ id, model }));
}
function currentBinding(view: NativeConfigurationView, role: NativeRouteRole) {
  return { provider: value(view.fields.find(row => row.path === `routes.${role}.provider_id`)?.effective),
    model: value(view.fields.find(row => row.path === `routes.${role}.model`)?.effective) };
}

export function NativeRouteBindingForm({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n(), roles = model.catalog?.routeBindings ?? [], providers = userProviders(view);
  const [role, setRole] = useState<NativeRouteRole>(roles[0] ?? 'reviewer');
  const initial = currentBinding(view, role);
  const [providerId, setProviderId] = useState(initial.provider ?? providers[0]?.id ?? '');
  const [modelId, setModelId] = useState(initial.model ?? providers.find(item => item.id === providerId)?.model ?? '');
  const selectedProvider = providers.find(item => item.id === providerId);
  const preview = model.preview?.request.operations[0]?.op === 'bind_route'
    && model.preview.request.operations[0].role === role ? model.preview : null;
  if (!roles.length) return null;
  const change = () => { invalidateNativePreview(model); model.setReceipt(null); model.setError(null); };
  const chooseRole = (next: NativeRouteRole) => {
    change(); setRole(next);
    const binding = currentBinding(view, next);
    const provider = providers.find(item => item.id === binding.provider) ?? providers[0];
    setProviderId(provider?.id ?? ''); setModelId(provider?.id === binding.provider ? binding.model ?? '' : provider?.model ?? '');
  };
  const chosen = currentBinding(view, role);
  const disabled = model.busy || Boolean(model.pendingOperation);
  return <section className="space-y-2 rounded border border-border/60 p-2" aria-label={t('settings.nativeRoutes.bindingTitle')}>
    <h4 className="font-semibold">{t('settings.nativeRoutes.bindingTitle')}</h4>
    <p>{t('settings.nativeRoutes.bindingScope')}</p>
    <label className="block">{t('settings.nativeRoutes.bindingRole')}
      <select aria-label={t('settings.nativeRoutes.bindingRole')} value={role} disabled={disabled}
        onChange={event => chooseRole(event.target.value as NativeRouteRole)}>
        {roles.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
    <p>{t('settings.nativeRoutes.provider')}: {chosen.provider ?? '—'}; {t('settings.nativeRoutes.model')}: {chosen.model ?? '—'}</p>
    <label className="block">{t('settings.nativeRoutes.bindingProvider')}
      <select aria-label={t('settings.nativeRoutes.bindingProvider')} value={selectedProvider?.id ?? ''} disabled={disabled || !providers.length}
        onChange={event => { change(); const next = providers.find(item => item.id === event.target.value);
          setProviderId(next?.id ?? ''); setModelId(next?.model ?? ''); }}>
        {!selectedProvider ? <option value="">{t('settings.nativeRoutes.chooseProvider')}</option> : null}
        {providers.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
      </select>
    </label>
    <label className="block">{t('settings.nativeRoutes.bindingModel')}
      <input aria-label={t('settings.nativeRoutes.bindingModel')} value={modelId} maxLength={256} disabled={disabled}
        onChange={event => { change(); setModelId(event.target.value); }} />
    </label>
    {!providers.length ? <p role="status">{t('settings.nativeRoutes.noUserProviders')}</p> : null}
    <button type="button" disabled={disabled || !selectedProvider || !modelId.trim()}
      onClick={() => previewNativeRouteBinding(model, view, role, providerId, modelId)}>
      {t('settings.nativeConfiguration.preview')}</button>
    {preview ? <div role="status">
      <p>{t('settings.nativeConfiguration.previewReady')}</p>
      <p>{t('settings.nativeRoutes.provider')}: {value(preview.result.view.fields.find(row => row.path === `routes.${role}.provider_id`)?.effective) ?? '—'};
        {' '}{t('settings.nativeRoutes.model')}: {value(preview.result.view.fields.find(row => row.path === `routes.${role}.model`)?.effective) ?? '—'}</p>
      <button type="button" disabled={disabled} onClick={() => publishNativeField(model, view)}>
        {t('settings.nativeConfiguration.save')}</button>
    </div> : null}
  </section>;
}
