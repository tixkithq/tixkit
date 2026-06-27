import type { ReactNode } from 'react';

export const metadata = {
  title: 'Tixkit Next SDK Demo',
  description: 'External Next.js demo for Tixkit checkout widgets and route handlers.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
