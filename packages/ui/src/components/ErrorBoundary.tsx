// SPDX-License-Identifier: Apache-2.0
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translate } from '../lib/i18n/store.ts';

interface Props {
  children?: ReactNode;
}
interface State {
  error: Error | null;
}

/** App-root error boundary (doc 01 §4.3 step 10). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error?.('[ErrorBoundary]', error, info.componentStack ?? '');
    this.setState({ error });
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
          <h2 style={{ fontSize: 16 }}>{translate('errorBoundary.title')}</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {String(this.state.error)}
          </pre>
          <button onClick={() => this.reload()} type="button">
            {translate('errorBoundary.reload')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }

  private reload(): void {
    window.location.reload();
  }
}
