export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded bg-primary text-sm font-bold text-primary-foreground">
            V
          </span>
          <span className="text-lg font-semibold tracking-tight">Velozity</span>
        </div>
        <main id="main-content">{children}</main>
        <p className="mt-8 text-center text-xs text-muted-foreground">
          Velozity Business OS
        </p>
      </div>
    </div>
  );
}
