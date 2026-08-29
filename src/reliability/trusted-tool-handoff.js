// SPDX-License-Identifier: Apache-2.0

const SCREENSHOT_TOOL = 'web.browse';
const INSPECTION_TOOL = 'image.inspect';

export function trustedToolHandoff(items = []) {
  const screenshot = [...items].reverse().find(isSuccessfulScreenshot);
  if (!screenshot) return null;
  const path = screenshot.result.metadata.path;
  const args = Object.freeze({ path });
  return Object.freeze({
    source_tool: SCREENSHOT_TOOL,
    source_action: 'screenshot',
    required_tool: INSPECTION_TOOL,
    workflowLeaseTools: Object.freeze([INSPECTION_TOOL]),
    args,
    hint: `The browser screenshot has already been captured successfully. Do not wait, sleep, echo readiness, or recapture it. `
      + `If visual interpretation is needed, call ${INSPECTION_TOOL} next with exactly ${JSON.stringify(args)}; `
      + 'that inspection has its own provider lifecycle. If existing evidence is already sufficient, continue or finish without a no-op tool call.',
  });
}

function isSuccessfulScreenshot(item) {
  return item?.request?.toolName === SCREENSHOT_TOOL
    && item.request.args?.action === 'screenshot'
    && item.result?.tool_name === SCREENSHOT_TOOL
    && item.result.status === 'succeeded'
    && item.result.metadata?.action === 'screenshot'
    && typeof item.result.metadata.path === 'string'
    && item.result.metadata.path.length > 0;
}
