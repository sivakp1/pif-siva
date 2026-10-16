"use client";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/misc";

/**
 * Shows a freshly issued API key exactly once (FE-11, AC-FE-7). The parent keeps the key only in
 * component state and clears it in onClose; it is never written to storage, the URL or the router cache.
 */
export function KeyRevealDialog({ apiKey, appId, note, onClose }: { apiKey: string | null; appId: string; note?: string; onClose: () => void }) {
  return (
    <Dialog
      open={apiKey !== null}
      onClose={onClose}
      dismissible={false}
      title={`API key for ${appId}`}
      description="Copy the key now and store it in your secret manager."
      footer={<Button onClick={onClose}>I have stored the key — close</Button>}
    >
      {apiKey ? (
        <div className="space-y-3">
          <Alert tone="warning" title="This key will not be shown again." />
          <code data-testid="api-key-value" className="block break-all rounded-md border bg-muted p-3 font-mono text-sm">
            {apiKey}
          </code>
          <CopyButton value={apiKey} label="Copy key" />
          {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
