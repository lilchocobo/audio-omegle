import ChatComponent from "@/components/ChatComponent";

// Dynamically import ChatComponent with SSR disabled

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4">
      <ChatComponent />
    </main>
  );
}