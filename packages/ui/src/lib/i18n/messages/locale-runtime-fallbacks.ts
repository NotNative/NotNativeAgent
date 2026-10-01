// SPDX-License-Identifier: Apache-2.0
import type { PartialDictionary } from './en.ts';

type RuntimeFallbackCatalog = PartialDictionary & Pick<PartialDictionary,
  | 'workspaceUi.workspaceFallback'
  | 'authUi.expired.title'
  | 'authUi.expired.body'
  | 'authUi.expired.action'
  | 'errorBoundary.title'
  | 'errorBoundary.reload'
  | 'themeUi.outsideProvider'
>;

export const deRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': 'Arbeitsbereich',
  'authUi.expired.title': 'Sitzung abgelaufen',
  'authUi.expired.body': 'Ihre Sitzung auf diesem Server hat geendet. Melden Sie sich erneut an, um fortzufahren.',
  'authUi.expired.action': 'Anmelden',
  'errorBoundary.title': 'NotNativeDesktop hat einen Fehler ausgelöst',
  'errorBoundary.reload': 'Neu laden',
  'themeUi.outsideProvider': 'useTheme außerhalb von ThemeProvider',
};

export const frRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': 'Espace de travail',
  'authUi.expired.title': 'Session expirée',
  'authUi.expired.body': 'Votre session sur ce serveur est terminée. Reconnectez-vous pour continuer.',
  'authUi.expired.action': 'Se connecter',
  'errorBoundary.title': 'NotNativeDesktop a rencontré une erreur',
  'errorBoundary.reload': 'Recharger',
  'themeUi.outsideProvider': 'useTheme en dehors de ThemeProvider',
};

export const zhCNRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': '工作区',
  'authUi.expired.title': '会话已过期',
  'authUi.expired.body': '您在此服务器上的会话已结束。请重新登录以继续。',
  'authUi.expired.action': '登录',
  'errorBoundary.title': 'NotNativeDesktop 发生错误',
  'errorBoundary.reload': '重新加载',
  'themeUi.outsideProvider': '在 ThemeProvider 之外调用了 useTheme',
};

export const zhTWRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': '工作區',
  'authUi.expired.title': '工作階段已過期',
  'authUi.expired.body': '您在此伺服器上的工作階段已結束。請重新登入以繼續。',
  'authUi.expired.action': '登入',
  'errorBoundary.title': 'NotNativeDesktop 發生錯誤',
  'errorBoundary.reload': '重新載入',
  'themeUi.outsideProvider': '在 ThemeProvider 之外呼叫 useTheme',
};

export const ukRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': 'Робочий простір',
  'authUi.expired.title': 'Сесію завершено',
  'authUi.expired.body': 'Сесію на цьому сервері завершено. Увійдіть знову, щоб продовжити.',
  'authUi.expired.action': 'Увійти',
  'errorBoundary.title': 'У NotNativeDesktop сталася помилка',
  'errorBoundary.reload': 'Перезавантажити',
  'themeUi.outsideProvider': 'useTheme поза ThemeProvider',
};

export const esRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': 'Espacio de trabajo',
  'authUi.expired.title': 'Sesión caducada',
  'authUi.expired.body': 'Tu sesión en este servidor ha terminado. Inicia sesión otra vez para continuar.',
  'authUi.expired.action': 'Iniciar sesión',
  'errorBoundary.title': 'NotNativeDesktop tuvo un error',
  'errorBoundary.reload': 'Recargar',
  'themeUi.outsideProvider': 'useTheme fuera de ThemeProvider',
};

export const ptBRRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': 'Espaço de trabalho',
  'authUi.expired.title': 'Sessão expirada',
  'authUi.expired.body': 'Sua sessão neste servidor terminou. Entre novamente para continuar.',
  'authUi.expired.action': 'Entrar',
  'errorBoundary.title': 'O NotNativeDesktop teve um erro',
  'errorBoundary.reload': 'Recarregar',
  'themeUi.outsideProvider': 'useTheme fora do ThemeProvider',
};

export const koRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': '작업 공간',
  'authUi.expired.title': '세션이 만료되었습니다',
  'authUi.expired.body': '이 서버의 세션이 종료되었습니다. 계속하려면 다시 로그인하세요.',
  'authUi.expired.action': '로그인',
  'errorBoundary.title': 'NotNativeDesktop에서 오류가 발생했습니다',
  'errorBoundary.reload': '새로 고침',
  'themeUi.outsideProvider': 'ThemeProvider 밖에서 useTheme 호출',
};

export const plRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': 'Obszar roboczy',
  'authUi.expired.title': 'Sesja wygasła',
  'authUi.expired.body': 'Sesja na tym serwerze się zakończyła. Zaloguj się ponownie, aby kontynuować.',
  'authUi.expired.action': 'Zaloguj się',
  'errorBoundary.title': 'NotNativeDesktop napotkał błąd',
  'errorBoundary.reload': 'Odśwież',
  'themeUi.outsideProvider': 'useTheme poza ThemeProvider',
};

export const jaRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': 'ワークスペース',
  'authUi.expired.title': 'セッションが期限切れです',
  'authUi.expired.body': 'このサーバーのセッションが終了しました。続行するには再度サインインしてください。',
  'authUi.expired.action': 'サインイン',
  'errorBoundary.title': 'NotNativeDesktop でエラーが発生しました',
  'errorBoundary.reload': '再読み込み',
  'themeUi.outsideProvider': 'ThemeProvider の外で useTheme を使用',
};

export const trRuntimeFallbacks: RuntimeFallbackCatalog = {
  'workspaceUi.workspaceFallback': 'Çalışma alanı',
  'authUi.expired.title': 'Oturum süresi doldu',
  'authUi.expired.body': 'Bu sunucudaki oturumunuz sona erdi. Devam etmek için yeniden giriş yapın.',
  'authUi.expired.action': 'Giriş yap',
  'errorBoundary.title': 'NotNativeDesktop bir hatayla karşılaştı',
  'errorBoundary.reload': 'Yeniden yükle',
  'themeUi.outsideProvider': 'ThemeProvider dışında useTheme',
};
