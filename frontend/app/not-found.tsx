import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">The page or record you asked for does not exist.</p>
      <Link href="/playground" className="mt-4 inline-block text-sm text-primary underline">
        Go to the playground
      </Link>
    </main>
  );
}
