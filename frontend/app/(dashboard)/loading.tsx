import { Spinner } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
      <Spinner label="Loading page" /> Loading…
    </div>
  );
}
