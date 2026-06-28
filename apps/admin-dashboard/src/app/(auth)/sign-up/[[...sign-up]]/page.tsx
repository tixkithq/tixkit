import { SignUp } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import { hasClerkKey } from '@/lib/auth';

export default function SignUpPage() {
  if (!hasClerkKey()) redirect('/dashboard');
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <SignUp />
    </div>
  );
}
