// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { NativeInstallationFailure, parseNativeInstallationView } from '../installation.ts';

const view = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', product: 'NotNativeAgent', version: '20261006-16',
  install_root: 'C:\\Program Files\\NotNativeAgent',
  data_root: 'C:\\Users\\operator\\AppData\\Roaming\\NotNativeAgent',
  node: 'C:\\runtime\\node.exe', node_major: 24 });

describe('native installation view parser', () => {
  it('accepts the verified descriptor grammar and refuses drift', () => {
    const parsed = parseNativeInstallationView(view());
    expect(parsed.product).toBe('NotNativeAgent');
    expect(parsed.node_major).toBe(24);
    expect(() => parseNativeInstallationView({ ...view(), product: 'Other' }))
      .toThrow(NativeInstallationFailure);
    expect(() => parseNativeInstallationView({ ...view(), version: '3' }))
      .toThrow(NativeInstallationFailure);
    expect(() => parseNativeInstallationView({ ...view(), node_major: 4 }))
      .toThrow(NativeInstallationFailure);
    expect(() => parseNativeInstallationView({ ...view(), extra: true }))
      .toThrow(NativeInstallationFailure);
    expect(() => parseNativeInstallationView({ ...view(), installation_id: 'bad id' }))
      .toThrow(NativeInstallationFailure);
  });
});
