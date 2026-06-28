import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Header } from '@/components/layout/header';
import { Main } from '@/components/layout/main';

export default function NotFound() {
  return (
    <>
      <Header />
      <Main>
        <div className="flex min-h-[60svh] flex-col items-center justify-center gap-6 text-center">
          <p className="text-5xl font-bold">404</p>
          <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
          <p className="max-w-md text-muted-foreground">
            The page you are looking for does not exist or may have been moved.
          </p>
          <Button asChild>
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </Main>
    </>
  );
}
