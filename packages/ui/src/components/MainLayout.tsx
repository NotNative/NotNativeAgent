import { ChatView } from './ChatView.tsx';
import { ContextRail, HeaderBar } from './ShellChrome.tsx';
import { SessionSidebar } from './SessionSidebar.tsx';

/** MainLayout region skeleton (doc 01 §13.1); surfaces/pages fill in per phase. */
export function MainLayout() {
  return (
    <div className="flex h-screen flex-col flex-1 bg-neutral-900 text-neutral-100">
      <HeaderBar />
      <div className="flex min-h-0 flex-1">
        <SessionSidebar />
        <ChatView />
        <ContextRail />
      </div>
    </div>
  );
}
