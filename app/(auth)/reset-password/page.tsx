import type { Metadata } from 'next';
import { ResetPasswordForm } from './reset-form';

export const metadata: Metadata = { title: 'Reset password' };

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
