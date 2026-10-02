// SPDX-License-Identifier: Apache-2.0

export function toolExchanges(records) {
  const requestIndexes = indexRecords(records, 'tool_request');
  const resultIndexes = indexRecords(records, 'tool_result');
  const partners = new Map(); const requests = new Map(); const results = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const request = records[index];
    if (request.type !== 'tool_request') continue;
    for (const key of identityKeys(request)) {
      const resultIndex = resultIndexes.get(key);
      if (requestIndexes.get(key) !== index || !Number.isInteger(resultIndex) || resultIndex <= index) continue;
      const result = records[resultIndex];
      if (partners.has(resultIndex) || !compatible(request, result)) continue;
      partners.set(index, resultIndex); partners.set(resultIndex, index);
      requests.set(result, request); results.set(request, result);
      break;
    }
  }
  return { partners, requests, results };
}

function indexRecords(records, type) {
  const indexes = new Map();
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].type !== type) continue;
    for (const key of identityKeys(records[index])) {
      // Invariant: repeated identities remain ambiguous; the last record never wins.
      indexes.set(key, indexes.has(key) ? null : index);
    }
  }
  return indexes;
}

function identityKeys(record) {
  const turn = record.turnId ?? record.turn_id ?? null;
  return [['request', record.requestId], ['provider', record.providerCallId]]
    .filter(([, id]) => typeof id === 'string' && id.trim().length > 0)
    .map(([kind, id]) => JSON.stringify([kind, turn, id]));
}

function compatible(request, result) {
  for (const key of ['requestId', 'providerCallId', 'toolName', 'stepId']) {
    if (request[key] && result[key] && request[key] !== result[key]) return false;
  }
  return true;
}
