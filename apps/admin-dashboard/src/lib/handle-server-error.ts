import { toast } from 'sonner'

export function handleServerError(error: unknown) {
  if (process.env.NODE_ENV === 'development') {
    console.log(error)
  }

  let errMsg = 'Something went wrong!'

  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    Number(error.status) === 204
  ) {
    errMsg = 'No content.'
  }

  if (error instanceof Error && error.message.length > 0) {
    errMsg = error.message
  }

  toast.error(errMsg)
}
