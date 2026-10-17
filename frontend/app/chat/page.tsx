import type { Metadata } from "next";
import { PublicChat } from "@/components/public-chat";

export const metadata: Metadata = {
  title: "Chat",
  description: "ShopKart assistant, protected by the Prompt-Injection Firewall",
};

/** Public page: no sign-in. Messages go through /api/public/chat → PIF /v1/chat. */
export default function ChatPage() {
  return <PublicChat />;
}
