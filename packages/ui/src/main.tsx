import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { I18nProvider } from './components/I18nProvider.tsx';
import { ThemeProvider } from './components/ThemeProvider.tsx';

export function renderMainApp(element: HTMLElement): void {
  createRoot(element).render(
    <StrictMode>
      <I18nProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
