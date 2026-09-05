// SPDX-License-Identifier: Apache-2.0
import { boundedProviderCapabilities, boundedProviderToolCallCompatibility } from '../provider/capabilities.js';

export async function testProviderProfile(profile, provider, options = {}) {
  if (typeof provider.capabilities !== 'function') {
    return { id: profile.id, ready: true, models: [profile.model], detail: 'Provider has no discovery endpoint; profile is structurally valid.' };
  }
  const capabilities = await boundedProviderCapabilities(provider, options.providerCapabilityDeadlineMs ?? 5_000);
  const compatibility = await toolCallCompatibility(profile, provider, capabilities, options);
  return {
    id: profile.id, ready: true,
    models: Array.isArray(capabilities?.models)
      ? capabilities.models.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 256) : [profile.model],
    tools: capabilities?.tools, images: capabilities?.images, tool_call_compatibility: compatibility,
  };
}

async function toolCallCompatibility(profile, provider, capabilities, options) {
  if (profile.trustZone === 'public_network' || capabilities?.tools === false
    || typeof provider.toolCallCompatibility !== 'function') {
    return { tested: false, supported_mode: 'unknown' };
  }
  const observed = await boundedProviderToolCallCompatibility(
    provider, options.providerCompatibilityDeadlineMs ?? 60_000,
  );
  return {
    tested: true, supported_mode: observed.supportedMode,
    configured_mode: profile.toolCallMode,
    compatible: observed.supportedMode === 'single' || profile.toolCallMode === 'batch',
    recommendation: observed.supportedMode === 'batch' && profile.toolCallMode !== 'batch'
      ? `Use /provider tool-calls ${profile.id} batch, then test this profile again.` : null,
  };
}
