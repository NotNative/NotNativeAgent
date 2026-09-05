// SPDX-License-Identifier: Apache-2.0
import {
  boundedProviderCapabilities, boundedProviderQualification, boundedProviderToolCallCompatibility,
} from '../provider/capabilities.js';

export async function testProviderProfile(profile, provider, options = {}) {
  if (typeof provider.capabilities !== 'function') {
    return { id: profile.id, ready: true, models: [profile.model], detail: 'Provider has no discovery endpoint; profile is structurally valid.' };
  }
  const capabilities = await boundedProviderCapabilities(provider, options.providerCapabilityDeadlineMs ?? 5_000);
  if (typeof provider.qualification === 'function') {
    const qualified = await boundedProviderQualification(
      provider, options.providerCompatibilityDeadlineMs ?? 60_000,
    );
    return qualifiedResult(profile, capabilities, qualified);
  }
  const compatibility = await toolCallCompatibility(profile, provider, capabilities, options);
  return {
    id: profile.id, ready: true,
    models: capabilityModels(profile, capabilities),
    tools: capabilities?.tools, images: capabilities?.images, tool_call_compatibility: compatibility,
    configuration: compatibility.tested ? {
      toolCallMode: compatibility.supported_mode, capabilities: { tools: true },
    } : null,
  };
}

export function appliedProviderTestResult(result) {
  if (!result.configuration) return result;
  return {
    ...result, configuration: { ...result.configuration, applied: true },
    tool_call_compatibility: {
      ...result.tool_call_compatibility,
      configured_mode: result.configuration.toolCallMode, compatible: true, recommendation: null,
    },
  };
}

function qualifiedResult(profile, capabilities, qualified) {
  return {
    id: profile.id, ready: true, models: capabilityModels(profile, capabilities),
    chat: true, tools: qualified.tools, images: qualified.images,
    request_compatibility: {
      chat: true, image: qualified.images,
      single_tool: qualified.singleToolCalls, batch_tool: qualified.batchToolCalls,
    },
    tool_call_compatibility: {
      tested: qualified.tools, supported_mode: qualified.tools ? qualified.toolCallMode : 'unsupported',
      configured_mode: profile.toolCallMode,
      compatible: !qualified.tools || profile.toolCallMode === qualified.toolCallMode || qualified.singleToolCalls,
      recommendation: null,
    },
    configuration: {
      toolCallMode: qualified.toolCallMode,
      capabilities: { tools: qualified.tools, images: qualified.images },
    },
  };
}

function capabilityModels(profile, capabilities) {
  return Array.isArray(capabilities?.models)
    ? capabilities.models.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
    : [profile.model];
}

async function toolCallCompatibility(profile, provider, capabilities, options) {
  if (capabilities?.tools === false || typeof provider.toolCallCompatibility !== 'function') {
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
