import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, appUrl, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
    links: [
      {
        text: 'Launch App',
        url: appUrl,
        external: true,
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
