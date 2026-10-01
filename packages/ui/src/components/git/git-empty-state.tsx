// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';

export function Centered({ label, testid }: { label: string; testid: string }): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground" data-testid={testid}>
      {label}
    </div>
  );
}

export function EmptyLine({ label }: { label: string }): ReactNode {
  return <div className="px-2 py-1 text-[11px] text-muted-foreground">{label}</div>;
}
