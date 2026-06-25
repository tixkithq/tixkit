import { SignIn } from '@clerk/nextjs'
import { redirect } from 'next/navigation'
import { hasClerkKey } from '@/lib/auth'

export default function SignInPage() {
  if (!hasClerkKey()) redirect('/dashboard')
  return (
    <div className='flex min-h-svh items-center justify-center p-4'>
      <SignIn />
    </div>
  )
}
