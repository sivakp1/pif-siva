import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/misc";
import { PlaygroundClient } from "./playground-client";

export const metadata: Metadata = { title: "Playground" };

export default function PlaygroundPage() {
  return (
    <>
      <PageHeader title="Playground" description="Scan a prompt and context documents against an app's policy. Scans are logged with origin=playground." />
      <PlaygroundClient />
    </>
  );
}
